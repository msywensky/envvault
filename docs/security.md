# Security design and threat model

How EnvVault protects your `.env` files: the cryptography, how the app is hardened, where env values can appear, what a git host sees, what EnvVault protects against and what it doesn't, and the vault's file format. The [README](../README.md#security) has a one-paragraph summary.

## Contents

- [Cryptography](#cryptography)
- [Electron hardening](#electron-hardening)
- [Env values](#env-values)
- [Data handling](#data-handling)
- [Git vaults](#git-vaults)
- [Threat model](#threat-model)
  - [Protects against](#protects-against)
  - [Does not protect against](#does-not-protect-against)
- [Vault format](#vault-format)

## Cryptography

- **Key derivation:** Argon2id (libsodium `crypto_pwhash`, MODERATE: 3 passes, 256 MiB) from your master password, run in a short-lived worker thread so the app never freezes.
- **Master password:** a new vault needs at least 12 characters and a password that [zxcvbn-ts](https://zxcvbn-ts.github.io/zxcvbn/) scores 3 or more (an estimated 10^8 guesses or more), counting your machine's name, your folders' names and "EnvVault" as easy to guess. This is checked before the key is derived. A delay in the app wouldn't help: someone with a copy of the vault guesses offline, on their own hardware, and pays only Argon2id's cost per guess.
- **Setup code:** a vault can also have a 128-bit secret that each of your machines keeps and the vault never holds; a git vault always does. The key then comes from the password _and_ that secret (HKDF-SHA256), so a copy of the vault alone can't be used to guess your password. A new machine gets the secret once, as a **setup code** you type with the password.
- **Encryption:** XChaCha20-Poly1305 with a random 24-byte nonce for every write. The entry's name is bound in as associated data, so copying `a.env.enc` over `b.env.enc`, or one `.env` in a folder over another, fails to decrypt instead of silently swapping secrets.
- **Entry names:** a `.env` in a folder of a repo (a monorepo's `apps/web/.env`) is stored under a keyed hash of its path, with the path itself inside the ciphertext, so the vault's names give away how many such files a repo has but not where they are (see [Vault format](#vault-format)).
- **Rollbacks:** each vault copy carries a version, inside the ciphertext. A copy whose version went backwards is shown as a conflict, never offered as a simple pull (see [sync status](../README.md#how-it-works)).

## Electron hardening

- Renderer is sandboxed and context-isolated with no Node integration. Navigation, `window.open`, webviews and all permission requests are denied, and only one instance runs.
- Strict Content-Security-Policy in production: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'` (no inline scripts or styles, no `eval`). Only the Vite dev server relaxes it, with inline styles and `ws://localhost:*` for hot reload.
- Electron fuses (`electronFuses` in `electron-builder.yml`) are set in the packaged app: `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and the `--inspect` family are off, the app loads only from `app.asar`, and the asar's integrity is validated. The `envvault` command runs under the user's own Node, so it doesn't depend on run-as-node.
- The packaged app refuses to start with `--remote-debugging-port` or `--remote-debugging-pipe` (Chromium's DevTools protocol, which the fuses don't cover), can't open DevTools, and has no View menu (DevTools, reload).
- The preload exposes named functions only (`window.envvault.*`), never `ipcRenderer` or IPC event objects.
- Every IPC call is checked:
  - it must come from the app's own window, main frame and URL;
  - its arguments are validated with a strict zod schema (unknown fields are rejected);
  - it always returns a `{ok, data}` / `{ok, error}` envelope, and error messages never echo input.
- The renderer never supplies a file system path: folders come from the native picker in the main process, repos are referred to by validated name, and a repo's `.env` files by a validated path inside the repo (a file named `.env`, at most 8 folders of ASCII letters, digits and `._@+-`, never `.`, `..`, `.git`, a trailing dot or a Windows device name). A git vault's URL is the one location it sends, and the main process parses it strictly first: only `https://`, `ssh://` or `user@host:path`, never credentials, local paths, `file://` or other transports, and nothing git or ssh could read as an option.

## Env values

**Env values cross IPC only in two places: the raw pull diff after you click Show values, and the vault-copy editor.** Everything else that crosses IPC is key names, statuses and metadata.

The raw diff:

- arrives masked: the main process replaces every value, the continuation lines of multi-line values and any unrecognised line with `••••••••` before sending it. Key names, comments and blank lines are kept;
- is sent with values only when you click **Show values**, and only for the exact local and vault content the preview showed;
- contains only the changed lines plus 3 lines of context around them (other unchanged lines are sent as a count);
- keeps its values only in the pull dialog (never the app's store), never logs them, and drops them after 60 seconds, when the window is hidden, when the dialog closes and when EnvVault locks.

The editor:

- receives the vault copy's values when you open it, and sends back only the keys you added, changed or removed, together with the vault version it opened, so it can't overwrite a newer copy;
- shows every value masked until you click **Show**, and masks them all again when the window is hidden or after a minute without input;
- keeps its values only in the editor (never the app's store), never logs them, and drops them when it closes and when EnvVault locks.

## Data handling

- A vault's secret (for setup codes) is kept on each machine in `vault-secrets.json` in EnvVault's settings folder, sealed with the OS's secure storage (the Keychain on macOS, DPAPI on Windows). It never goes into the vault. The setup code itself is shown when you create the vault and, after you re-enter the password, in Settings; it's never logged, and the app forgets it once it's off the screen. A setup code typed on a new machine is kept only once the password proves right.
- The derived key lives only in the main process. Each operation gets its own copy, which is wiped when it finishes. The key is wiped on lock, on idle timeout (default 5 minutes), when the window closes, and when the computer sleeps or its screen locks. Auto-lock can be turned off in Settings, after a warning; the other three always apply.
- Repo names are restricted (ASCII, no `..`, no Windows device names), and so are the paths of `.env` files in a repo's folders. Every path is resolved and checked to stay inside its root after following symlinks, a symlinked `.env` is refused, and so is a `.env` with a symlink anywhere between it and its repo's folder.
- EnvVault finds the `.env` files in a repo's folders with `git ls-files`, run in every repo in your projects folder when the repository list opens and on Refresh. `ls-files` reads git's index but never refreshes it, unlike `git status`, so no clean or smudge filters run; it runs with `core.fsmonitor` off like every git command EnvVault runs in a repo, and never reads a folder git ignores.
- `.env.example` is read with the same checks as `.env` (no symlinks, at most 1 MiB), only to compare it. Only key names leave the main process.
- Values of machine-specific keys (`# envvault:local`) are never uploaded: the vault copy holds only their key names and markers, encrypted like everything else.
- Automatic pull is off by default: with it on, a push from any of your machines (or from anything allowed to push, such as the command line) changes this machine's `.env` files without review. When on, it applies only one-sided changes (the vault copy is newer and your `.env` is unchanged since the last sync, or missing), never a conflict or a rollback, with the same git checks and backup as a manual pull. It runs only while EnvVault is unlocked and doesn't count as activity, so it never keeps the vault unlocked. Mini mode's status checks don't count as activity either.
- Command-line access is off by default. When it's on:
  - EnvVault listens on a socket in its settings folder (mode `0600`) on macOS, or a named pipe on Windows;
  - every request must carry a random token from a file only you can read, replaced each time it starts;
  - requests are validated like IPC calls and get key names, statuses and hashes back, never values;
  - they don't count as activity, so they never keep the vault unlocked;
  - a push is refused if the vault copy changed on another machine.
- Pulls are refused unless `.env` is git-ignored and **not tracked**, checked by git in the file's own folder. The backup and the temp file are named so `.env.bak.*` covers them, and they are checked too, so a crash never leaves secrets in a file git would commit. A pull never creates a folder.
- Removing a vault copy deletes its entry only if it is still the version you saw (in a git vault, a commit without the file, pushed with the same lease as a write). No `.env` is touched on any machine, and this machine keeps the removed version as a floor, so a later push of the file continues above it and machines that synced the old copy don't take the new one for a rollback.
- Writes are atomic: temp file in the same folder, fsync, rename (retried on Windows sharing violations).
- Writes are also conditional: EnvVault writes a vault file only if it is still the version it read, so a push can't overwrite a copy that changed after you reviewed it. `meta.json` is written only if there is none, so creating a vault can't overwrite one that synced in at the same moment. In a synced folder this is exact on one machine and best-effort between machines, because Drive brings in another machine's change only when it syncs.
- `meta.json` is treated as attacker-controlled:
  - KDF parameters must be between MODERATE and SENSITIVE (this stops downgrades and denial of service);
  - the key check is bound to the vault ID;
  - EnvVault refuses to create a new vault in a folder that already holds encrypted entries.
- git runs from an absolute path resolved through absolute `PATH` entries only, so a repo can't ship its own `git.exe`, and with `core.fsmonitor` disabled, so a repo's `.git/config` can't make git run commands.

## Git vaults

- **What the host sees:** the same as a synced folder: ciphertext, the plaintext `meta.json` (KDF parameters, salt, key check), file names (your repo names, lowercased, and a hashed tag per `.env` in a repo's folders) and sizes, and when each change was made. Never values, key names or machine names: every commit is by `EnvVault <envvault@users.noreply.invalid>`, with the message "EnvVault update".
- **Your own credentials:** git uses your SSH key or credential helper. EnvVault never sees, asks for or stores a token, and refuses a URL that contains one.
- **Private repositories only:** checked when you choose the repository and again before every create and unlock, so a repository made public later is refused at the next unlock. EnvVault asks the host over https **with none of your credentials**: an environment built from scratch (no askpass programs, no config passed through variables), an empty home and global config, no system config, no credential helper, and a working folder outside any repository. If the host lists the branches, the repository is public and refused. Only a host asking for credentials counts as private: a "not found", an SSH-only host or no network gives no clear answer, and that is refused at first. A repository found to be public is always refused, with no override. For a host that gives no clear answer (your own SSH-only server, say), Setup shows the refusal and asks you to confirm that the repository is private. That confirmation is saved for that repository only (`privateConfirmed` in `config.json`) and replaces the check at later unlocks, so it is your assertion, not EnvVault's verification: if that repository is ever made readable without signing in, EnvVault will not notice. A hand-edited `config.json` can set it, but anyone who can edit that file can already point the vault elsewhere.
- **No checkout, no hooks:** EnvVault keeps a bare mirror in its settings folder (`git-vaults/`) and never checks out a working tree, so nothing the remote sends is ever run. Every command runs with an empty hooks folder (your global hooks don't run either), `core.fsmonitor` off, only the `https` and `ssh` protocols, fsck on every object received, no terminal prompts, and ssh in batch mode unless you set `core.sshCommand`.
- **Conditional pushes:** a write commits one file on top of the branch as EnvVault last saw it and pushes with a lease on that commit, so it lands only if nobody pushed in between (not even a reset). If someone did, EnvVault fetches and builds on their commit, and refuses if they changed the same file.
- **Only a vault:** EnvVault uses a repository only if it is empty or already a vault (a README, LICENSE, `.gitignore` or `.gitattributes` is fine), so a project repository isn't turned into a vault by mistake. Other files in the repository are kept untouched by its commits.

## Threat model

### Protects against

- The cloud provider or git host, or anyone else with access to the vault, reading your secrets, tampering with them, swapping files between repos or between a repo's `.env` files, rolling a file back, or weakening the KDF in `meta.json`.
- A stolen laptop while EnvVault is locked (the vault key is not stored anywhere).
- With a setup code: someone with a copy of the vault (a leaked or briefly public repository, its history, the host's staff, a shared Drive folder) guessing your master password offline. They'd need the vault's secret too, 128 random bits that never leave your machines and your password manager.
- Accidentally committing pulled secrets (ignore and tracked checks).

### Does not protect against

- Malware running as you on an unlocked machine. With command-line access on, such a program doesn't even need to read EnvVault's memory: it can list your repo and key names and push a `.env`, which automatic pull then brings to your other machines. It can't get values through the command line, but it could read your `.env` files directly anyway.
- A weak master password, for a vault without a setup code, or for someone who also has one of your machines (with its OS login) or your setup code. Use a long, unique password, and keep it and the setup code in your password manager. The strength check can't tell whether you use the password anywhere else, and a score of 3 still lets through passwords like `Summer2026!!!`.
- Losing the setup code and every machine that has it: the vault can't be opened, even with the password.
- The plaintext `.env` and `.env.bak.*` files in your repos. They are created with mode `0600` on macOS, but **on Windows file permissions come from the folder's ACL** (your user profile is normally private to you). EnvVault keeps the 3 newest backups per file by default (Settings: 1–50, or none) and deletes older ones when a pull writes a new one. Git ignores them, but tools that don't read `.gitignore` (a Docker build context, a zip of the folder) include them unless told not to.
- The master password sitting briefly in JavaScript memory. JS strings can't be wiped; only the derived key is.
- Secrets in `.env.example` that don't look like secrets. The same-value check is a heuristic.
- Secrets kept in comments (for example a commented-out key). Comments aren't values, so the masked raw diff shows them.
- Someone seeing your screen while a raw diff or the editor shows values. Those values also stay in the renderer's memory until they are garbage-collected, for the same reason. A masked field still shows how long its value is.
- Metadata: repo names, how many `.env` files each repo has in its folders, file sizes and modification times are visible in the vault folder or repository.
- Old copies in a git vault's history, which keeps every version of every file for good (Drive's version history keeps some too). If your master password and setup code leak, change the secrets themselves, not just the password: the old copies open with the old password and code.
- The git host's admins, or anyone who can push to the repository, deleting the vault or putting old copies back. A copy that went backwards shows as a conflict, as in a folder.
- Secrets pushed while a git vault was public. It's refused at the next unlock, but anything pushed meanwhile may have been copied (it's ciphertext, so the master password still protects it).
- A rollback on a machine that has never synced that repo (there is no earlier version to compare against).

## Vault format

| File                    | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta.json`             | `{ formatVersion: 1, vaultId, kdf: { alg: "argon2id", opslimit, memlimit, salt }, keyCheck }` (plaintext). Format 2, with a setup code, adds `secretId`, a public fingerprint of the vault's secret, and its key is HKDF-SHA256 of the Argon2id output salted with the secret.                                                                                                                                                                                                                                                                        |
| `<repo>.env.enc`        | A repo's root `.env`: `"EVV1"` + 24-byte nonce + XChaCha20-Poly1305 ciphertext of `{ version, updatedAt, updatedBy, contentHash, envBase64 }`. The AAD is `envvault:v1:<repo>`. Repo names are lowercased. Machine-specific keys are stored as `KEY=` under their marker.                                                                                                                                                                                                                                                                             |
| `<repo>.<tag>.file.enc` | A `.env` in one of the repo's folders. The same, with the file's path in the repo added to the ciphertext (`path`, for example `apps/web/.env`). The AAD is `envvault:file:v1:<repo>/<tag>`. `<tag>` is the first 8 bytes, in hex, of HMAC-SHA256 over `<repo>/<lowercased path>`, keyed with HKDF-SHA256 of the vault key (empty salt, info `envvault:file-tag:v1`), so only someone with the key can tell which path a tag stands for or check a guess. A reader refuses one whose `path` isn't valid, is the root `.env`, or doesn't give its tag. |
| `.<file>.<hex>.tmp`     | In-flight atomic writes. Stale ones are removed when you unlock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Anything else in the folder (for example Drive's `name (1).ext` conflict copies) is ignored. EnvVault 0.1.0 ignores `.file.enc` entries too, and keeps syncing root `.env` files with newer versions.

In a git vault, the same files sit at the top of the repository's default branch, one commit per change, with no temp files. Anything else there (a README, folders) is ignored and kept.
