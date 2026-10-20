# Security design and threat model

## Summary

- Env files and repo settings are encrypted with XChaCha20-Poly1305, under a key derived with Argon2id from your master password.
- A setup code (the default; always for a git vault) adds a 128-bit secret only your machines hold, so a copy of the vault can't be used to guess the password.
- The sync folder or git host sees ciphertext, `meta.json` (KDF parameters, salt, key check), repo names, how many env files each repo has, sizes and change times; never values, key names or file paths.
- The key stays in EnvVault's main process and is wiped on lock. Values reach the window only when you ask.
- Not protected: malware running as you while EnvVault is unlocked, a weak password (without a setup code, or once the code leaks), and the plaintext `.env` files and backups in your repos.

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

- **Key derivation:** Argon2id (libsodium `crypto_pwhash`, MODERATE: 3 passes, 256 MiB) from your master password.
- **Master password:** a new vault needs at least 12 characters and a [zxcvbn-ts](https://zxcvbn-ts.github.io/zxcvbn/) score of 3 or more (about 10^8 guesses), with your machine's and folders' names and "EnvVault" counted as easy to guess. An app-side delay wouldn't help: a copied vault is attacked offline, at Argon2id's cost per guess.
- **Setup code:** an optional 128-bit secret that each of your machines keeps and the vault never holds (always used by a git vault). The key then comes from the password and the secret (HKDF-SHA256). A new machine gets the secret once, as a setup code typed with the password.
- **Encryption:** XChaCha20-Poly1305 with a random 24-byte nonce for every write. The entry's name is bound in as associated data, so an entry copied over another fails to decrypt instead of swapping secrets.
- **Entry names:** an env file other than a repo's root `.env` is stored under a keyed hash of its path, and the path is kept inside the ciphertext.
- **Repo settings** are one entry, `settings.enc`, encrypted the same way with its own associated data, so ignored repos' names and the patterns stay secret.
- **Rollbacks:** each copy's version is inside the ciphertext. A copy whose version went backwards is shown as a conflict, never offered as a simple pull (see [sync status](../README.md#how-it-works)).

## Electron hardening

- The renderer is sandboxed and context-isolated, with no Node integration. Navigation, `window.open`, webviews and all permission requests are denied, and only one instance runs.
- Production Content-Security-Policy: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'` (no inline scripts or styles, no `eval`). Only the Vite dev server relaxes it, for inline styles and `ws://localhost:*`.
- The packaged app's Electron fuses turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and the `--inspect` family, and load only an integrity-checked `app.asar`. It refuses to start with `--remote-debugging-port` or `--remote-debugging-pipe`, which the fuses don't cover, and has no DevTools or View menu.
- The preload exposes named functions only (`window.envvault.*`), never `ipcRenderer` or IPC event objects.
- Every IPC call must come from the app's own window, main frame and URL. It's validated with a strict zod schema, and returns a `{ok, data}` / `{ok, error}` envelope whose errors never echo input.
- Paths and URLs from the renderer are strictly validated. It never sends a file system path (folders come from the native picker), every path must stay inside its root after following symlinks, a symlinked `.env` or folder is refused, and a git vault's URL must be `https://`, `ssh://` or `user@host:path`, without credentials.

## Env values

**Env values cross IPC in only two places: the raw pull diff after you click Show values, and the vault-copy editor.** Everything else is key names, statuses and metadata, and no value is ever logged.

- **The raw diff** is masked in the main process: values, multi-line continuations and unrecognised lines become `••••••••`. **Show values** sends only the changed lines plus 3 lines of context, for the exact content the preview showed. Values stay only in the pull dialog, never the app's store, and are dropped after 60 seconds, when the window is hidden, the dialog closes or EnvVault locks.
- **The editor** receives the vault copy's values when it opens, and sends back only the keys you changed, with the version it opened, so it can't overwrite a newer copy. Values stay only in the editor, never the app's store, and are dropped when it closes or EnvVault locks. How it masks them is in [Editing the vault copy](../README.md#editing-the-vault-copy).

## Data handling

- **Setup code:** each machine keeps the vault's secret in `vault-secrets.json`, sealed with the OS's secure storage (the Keychain or DPAPI). The code is shown at creation and, after the password, in Settings. It's never logged, is forgotten once it's off the screen, and is kept on a new machine only once the password proves right.
- **The key** lives only in the main process; each operation gets a copy, wiped when it finishes. It's wiped on lock, idle timeout (default 5 minutes; can be turned off after a warning), window close, sleep and screen lock.
- **Finding env files:** `git ls-files`, which never refreshes the index (unlike `git status`), so no clean or smudge filters run, and skips folders git ignores. Templates, backups and tracked variants never sync; ignored repos are never read.
- **`.env.example`** is read with the same checks as `.env` (and at most 1 MiB), only to compare it. Only key names leave the main process.
- **Machine-specific values** (`# envvault:local`) are never uploaded: the vault copy has `KEY=` under the marker.
- **Pulls** are refused unless the env file is git-ignored and **not tracked**, checked by git in the file's folder. The backup and the temp file are named so `.env.bak.*` covers them, and are checked too. A pull never creates a folder.
- **Removing a vault copy** deletes only the version you saw, touches no `.env`, and keeps that version as this machine's floor, so a later push continues above it.
- **Writes** are atomic (temp file, fsync, rename) and conditional: a vault file is written only if it's still at the version EnvVault read, so a push can't overwrite a copy that changed after review, and `meta.json` only if none exists. In a synced folder this is exact on one machine, best effort between machines.
- **`meta.json` is attacker-controlled:** its KDF parameters must be between MODERATE and SENSITIVE (no downgrade, no denial of service), the key check is bound to the vault ID, and EnvVault won't create a vault where encrypted entries already exist.
- **git** runs from an absolute path found through absolute `PATH` entries only, so a repo can't ship its own `git.exe`. It always runs with fsmonitor off and never runs hooks: in your repos EnvVault runs only `ls-files` and `check-ignore`, and a git vault's commands use an empty hooks folder.
- **Automatic pull** (off by default) applies a push from any of your machines, or anything allowed to push, to this machine's env files without review, and never keeps the vault unlocked. See [Automatic pull](../README.md#automatic-pull).
- **Command-line access** (off by default) listens on a `0600` socket (macOS) or a named pipe (Windows). Each request needs a random token from a file only you can read, replaced at every start; requests are validated like IPC calls, never get values back, and don't keep the vault unlocked. See [Command line](../README.md#command-line).

## Git vaults

- **What the host sees:** what a synced folder shows ([Vault format](#vault-format)), plus when each change was made. Commits are by `EnvVault <envvault@users.noreply.invalid>` ("EnvVault update"), with no machine name or identity.
- **Your credentials:** git uses your SSH key or credential helper. EnvVault never sees or stores a token, and refuses a URL that contains one.
- **Private repositories only**, checked when you choose one and before every create and unlock. EnvVault asks the host over https with none of your credentials or git config. A repository that lists its branches is public and always refused; only one that asks for credentials counts as private. Any other answer (a "not found", an SSH-only host, no network) is refused until you confirm in Setup that it's private. That confirmation (`privateConfirmed` in `config.json`, per repository) replaces the check at later unlocks, so EnvVault won't notice if the repository is later made public. Anyone who can edit `config.json` could set it, but could already point the vault elsewhere.
- **No checkout:** a bare mirror in `git-vaults/`, never a working tree, so nothing the remote sends is run. Only `https` and `ssh` are allowed, every object received is checked with fsck, git never prompts, and ssh runs in batch mode unless you set `core.sshCommand`.
- **Conditional pushes:** a write is one commit on the head EnvVault last saw, pushed with a lease on it, so it lands only if nobody pushed or reset the branch meanwhile. Otherwise EnvVault builds on the new head, and refuses if the same file changed.
- **Only a vault:** a repository must be empty or already a vault (a README, LICENSE, `.gitignore` or `.gitattributes` is fine), and other files are left untouched.

## Threat model

### Protects against

- The cloud provider, the git host or anyone else with access to the vault reading your secrets, tampering with them, swapping files between repos or between a repo's env files, rolling a file back, or weakening the KDF in `meta.json`.
- A stolen laptop while EnvVault is locked (the vault key is not stored anywhere).
- With a setup code: someone with a copy of the vault (a leaked or briefly public repository, its history, the host's staff, a shared Drive folder) guessing your master password offline: they'd also need the 128-bit secret.
- Accidentally committing pulled secrets (the ignore and tracked checks).

### Does not protect against

- Malware running as you on an unlocked machine. With command-line access on, it can list your repo and key names and push a `.env`, which automatic pull then brings to your other machines. It can't get values through the command line, but it could read your `.env` files directly anyway.
- A weak master password, for a vault without a setup code, or against someone who also has one of your machines (with its OS login) or your setup code. Keep a long, unique password and the setup code in your password manager. The strength check can't detect reuse, and a score of 3 still allows passwords like `Summer2026!!!`.
- Losing the setup code and every machine that has it: the vault can't be opened, even with the password.
- The plaintext `.env` and `.env.bak.*` files in your repos. They're created with mode `0600` on macOS, but **on Windows their permissions come from the folder's ACL** (your user profile is normally private to you). Tools that don't read `.gitignore`, such as a Docker build context, include them. How many backups are kept is in [How it works](../README.md#how-it-works).
- The master password sitting briefly in JavaScript memory. JS strings can't be wiped; only the derived key is.
- Secrets in `.env.example` that don't look like secrets. The same-value check is a heuristic.
- Secrets kept in comments. Comments aren't values, so the masked raw diff shows them.
- Someone seeing your screen while values are shown. They also stay in the renderer's memory until garbage-collected, and a masked field still shows its value's length.
- Metadata: repo names, how many env files each repo has besides its root `.env`, file sizes and modification times, and the size of `settings.enc` and when it changed.
- The host deleting `settings.enc` or putting an old copy back. It can't read or forge the settings, but every machine then uses the built-in (or old) ones: an ignored repo is listed again, and files you stopped syncing show as excluded or disappear. File contents are never affected, and every push is still reviewed.
- Old copies in a git vault's history, which keeps every version for good (Drive's version history keeps some too). If your password and setup code leak, change the secrets in your env files too: old copies open with the old password and code.
- The git host's admins, or anyone who can push, deleting the vault or putting old copies back. A copy that went backwards shows as a conflict.
- Secrets pushed while a git vault was public. It's refused at the next unlock, but anything pushed meanwhile may have been copied (as ciphertext, still protected by the password and setup code).
- A rollback on a machine that has never synced that file.

## Vault format

| File                    | Layout                                                                                                                   | AAD                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `meta.json`             | Plaintext `{ formatVersion, vaultId, kdf: { alg, opslimit, memlimit, salt }, secretId, keyCheck }`                       | `envvault:keycheck:<vaultId>`   |
| `<repo>.env.enc`        | A repo's root `.env`: `"EVV1"`, 24-byte nonce, ciphertext of `{ version, updatedAt, updatedBy, contentHash, envBase64 }` | `envvault:v1:<repo>`            |
| `<repo>.<tag>.file.enc` | Any other env file in the repo: the same, plus `path`                                                                    | `envvault:file:v1:<repo>/<tag>` |
| `settings.enc`          | The same envelope around `{ format: 1, updatedAt, updatedBy, defaults, repos }`                                          | `envvault:settings:v1`          |
| `.<file>.<hex>.tmp`     | A write in progress (folder vaults only), removed when you unlock                                                        | —                               |

- `<repo>` is the repo name, lowercased. `<tag>` is the first 8 bytes, in hex, of HMAC-SHA256 over `<repo>/<lowercased path>`, keyed with HKDF-SHA256 of the vault key (empty salt, info `envvault:file-tag:v1`), so only someone with the key can tell which path a tag stands for or check a guess.
- `formatVersion` is 1 without a setup code and 2 with one. Format 2 adds `secretId`, a public fingerprint of the secret that tells a wrong code from a wrong password, and its key is HKDF-SHA256 of the Argon2id output, salted with the secret.
- A reader refuses a file entry whose `path` is the root `.env` or doesn't match its tag (tampering), or that it doesn't sync (a newer EnvVault's). It keeps unknown `settings.enc` fields when writing, refuses a newer `format`, and uses the built-in settings while the file fails verification.
- Other files, such as Drive's conflict copies, are ignored. A git vault keeps these files at the top of its default branch, one commit per change, and leaves other files alone.
