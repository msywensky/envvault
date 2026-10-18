# EnvVault

[![CI](https://github.com/msywensky/envvault/actions/workflows/ci.yml/badge.svg)](https://github.com/msywensky/envvault/actions/workflows/ci.yml)

A desktop app (Electron + Vue 3 + TypeScript, macOS and Windows) that keeps each project's `.env` file in sync between your machines, through an **encrypted** vault: a folder synced between them (such as a Google Drive folder), or a private git repository. The sync folder or the git host only ever sees ciphertext. Plaintext stays in your repos, which EnvVault checks are git-ignored before it writes anything.

![Repositories view](docs/repos.png)

## How it works

```
Projects folder (each machine)          Vault folder (synced by Google Drive etc.)
  api/.env      ── push ──▶ encrypt ──▶   api.env.enc
  web/.env      ◀── pull ── decrypt ◀──   web.env.enc
                                          meta.json   (KDF params, salt, key check)
```

The vault can also be a **private git repository** instead of a synced folder: the same files, on one branch, which EnvVault fetches and pushes itself (see [Git vaults](#git-vaults)).

- **Key derivation:** Argon2id (libsodium `crypto_pwhash`, MODERATE: 3 passes, 256 MiB) from your master password, run in a short-lived worker thread so the app never freezes.
- **Encryption:** XChaCha20-Poly1305 with a random 24-byte nonce for every write. The repo name is bound in as associated data, so copying `a.env.enc` over `b.env.enc` fails to decrypt instead of silently swapping secrets.
- **Sync status** is three-way: local file, vault copy, and what this machine last synced. That separates "local newer", "vault newer" and "conflict". A vault copy whose version went backwards (a rollback) is shown as a conflict, never offered as a simple pull. The one exception is when it is byte-identical to your local file: then nothing would change either way, and it shows as in sync.

| Status      | Meaning                                                                                      | Action                  |
| ----------- | -------------------------------------------------------------------------------------------- | ----------------------- |
| In sync     | Local and vault are byte-identical, apart from machine-specific values                       | —                       |
| Local only  | Never pushed                                                                                 | Push                    |
| Local newer | Only you changed it since the last sync                                                      | Push                    |
| Vault newer | Only another machine changed it                                                              | Pull                    |
| Conflict    | Both changed, or they differ and this machine never synced them, or the vault went backwards | Keep local / Keep vault |
| Vault only  | In the vault, but the repo isn't in your projects folder                                     | —                       |
| No .env     | Nothing on either side                                                                       | —                       |

Every push and pull shows a confirmation with the **key names** that will be added, removed or changed, never their values. Pushing over a vault copy that someone else changed needs an explicit "overwrite anyway". A pull first saves your current `.env` as `.env.bak.<timestamp>`.

To see exactly what a pull would change, click **Show raw diff** in the pull dialog. It shows a line-by-line diff from your `.env` to the vault copy with every value masked (`KEY=••••••••`); comments are shown as they are. Click **Show values** to see the values; they are hidden again after a minute (see [Security design](#security-design)).

![Resolving a conflict: key names only, explicit overwrite](docs/conflict.png)

## Security design

**Electron hardening**

- Renderer is sandboxed and context-isolated with no Node integration. Navigation, `window.open`, webviews and all permission requests are denied, and only one instance runs.
- Strict Content-Security-Policy in production: `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'` (no inline scripts or styles, no `eval`).
- The preload exposes named functions only (`window.envvault.*`), never `ipcRenderer` or IPC event objects.
- Every IPC call is checked:
  - it must come from the app's own window, main frame and URL;
  - its arguments are validated with a strict zod schema (unknown fields are rejected);
  - it always returns a `{ok, data}` / `{ok, error}` envelope, and error messages never echo input.
- The renderer never supplies file paths: folders come from the native picker in the main process, and repos are referred to by validated name. A git vault's URL is the one location it sends, and the main process parses it strictly first: only `https://`, `ssh://` or `user@host:path`, never credentials, local paths, `file://` or other transports, and nothing git or ssh could read as an option.
- **Env values cross IPC only in two places: the raw pull diff after you click Show values, and the vault-copy editor.** Everything else that crosses IPC is key names, statuses and metadata. The raw diff:
  - arrives masked: the main process replaces every value, the continuation lines of multi-line values and any unrecognised line with `••••••••` before sending it. Key names, comments and blank lines are kept;
  - is sent with values only when you click **Show values**, and only for the exact local and vault content the preview showed;
  - contains only the changed lines plus 3 lines of context around them (other unchanged lines are sent as a count);
  - keeps its values only in the pull dialog (never the app's store), never logs them, and drops them after 60 seconds, when the window is hidden, when the dialog closes and when EnvVault locks.

  The editor:

  - receives the vault copy's values when you open it, and sends back only the keys you added, changed or removed, together with the vault version it opened, so it can't overwrite a newer copy;
  - shows every value masked until you click **Show**, and masks them all again when the window is hidden or after a minute without input;
  - keeps its values only in the editor (never the app's store), never logs them, and drops them when it closes and when EnvVault locks.

**Data handling**

- The derived key lives only in the main process. Each operation gets its own copy, which is wiped when it finishes. The key is wiped on lock, on idle timeout (default 5 minutes), when the window closes, and when the computer sleeps or its screen locks.
- Repo names are restricted (ASCII, no `..`, no Windows device names). Every path is resolved and checked to stay inside its root after following symlinks, and a symlinked `.env` is refused.
- `.env.example` is read with the same checks as `.env` (no symlinks, at most 1 MiB), only to compare it. Only key names leave the main process.
- Values of machine-specific keys (`# envvault:local`) are never uploaded: the vault copy holds only their key names and markers, encrypted like everything else.
- Automatic pull applies only one-sided changes (the vault copy is newer and your `.env` is unchanged since the last sync, or missing), never a conflict or a rollback, with the same git checks and backup as a manual pull. It runs only while EnvVault is unlocked and doesn't count as activity, so it never keeps the vault unlocked.
- Command-line access is off by default. When it's on:
  - EnvVault listens on a socket in its settings folder (mode `0600`) on macOS, or a named pipe on Windows;
  - every request must carry a random token from a file only you can read, replaced each time it starts;
  - requests are validated like IPC calls and get key names, statuses and hashes back, never values;
  - they don't count as activity, so they never keep the vault unlocked;
  - a push is refused if the vault copy changed on another machine.
- Pulls are refused unless `.env` is git-ignored and **not tracked**. The backup and the temp file are named so `.env.bak.*` covers them, and they are checked too, so a crash never leaves secrets in a file git would commit.
- Writes are atomic: temp file in the same folder, fsync, rename (retried on Windows sharing violations).
- Writes are also conditional: EnvVault writes a vault file only if it is still the version it read, so a push can't overwrite a copy that changed after you reviewed it. `meta.json` is written only if there is none, so creating a vault can't overwrite one that synced in at the same moment. In a synced folder this is exact on one machine and best-effort between machines, because Drive brings in another machine's change only when it syncs.
- `meta.json` is treated as attacker-controlled:
  - KDF parameters must be between MODERATE and SENSITIVE (this stops downgrades and denial of service);
  - the key check is bound to the vault ID;
  - EnvVault refuses to create a new vault in a folder that already holds encrypted entries.
- git runs from an absolute path resolved through absolute `PATH` entries only, so a repo can't ship its own `git.exe`, and with `core.fsmonitor` disabled, so a repo's `.git/config` can't make git run commands.

**Git vaults**

- **What the host sees:** the same as a synced folder: ciphertext, the plaintext `meta.json` (KDF parameters, salt, key check), file names (your repo names, lowercased) and sizes, and when each change was made. Never values, key names or machine names: every commit is by `EnvVault <envvault@users.noreply.invalid>`, with the message "EnvVault update".
- **Your own credentials:** git uses your SSH key or credential helper. EnvVault never sees, asks for or stores a token, and refuses a URL that contains one.
- **Private repositories only:** checked when you choose the repository and again before every create and unlock, so a repository made public later is refused at the next unlock. EnvVault asks the host over https **with none of your credentials**: an environment built from scratch (no askpass programs, no config passed through variables), an empty home and global config, no system config, no credential helper, and a working folder outside any repository. If the host lists the branches, the repository is public and refused. Only a host asking for credentials counts as private: a "not found", an SSH-only host or no network gives no clear answer, and that is refused too. There is no override.
- **No checkout, no hooks:** EnvVault keeps a bare mirror in its settings folder (`git-vaults/`) and never checks out a working tree, so nothing the remote sends is ever run. Every command runs with an empty hooks folder (your global hooks don't run either), `core.fsmonitor` off, only the `https` and `ssh` protocols, fsck on every object received, no terminal prompts, and ssh in batch mode unless you set `core.sshCommand`.
- **Conditional pushes:** a write commits one file on top of the branch as EnvVault last saw it and pushes with a lease on that commit, so it lands only if nobody pushed in between (not even a reset). If someone did, EnvVault fetches and builds on their commit, and refuses if they changed the same file.
- **Only a vault:** EnvVault uses a repository only if it is empty or already a vault (a README, LICENSE, `.gitignore` or `.gitattributes` is fine), so a project repository isn't turned into a vault by mistake. Other files in the repository are kept untouched by its commits.

## Threat model

**Protects against**

- The cloud provider or git host, or anyone else with access to the vault, reading your secrets, tampering with them, swapping files between repos, rolling a file back, or weakening the KDF in `meta.json`.
- A stolen laptop while EnvVault is locked (the vault key is not stored anywhere).
- Accidentally committing pulled secrets (ignore and tracked checks).

**Does not protect against**

- Malware running as you on an unlocked machine. With command-line access on, such a program doesn't even need to read EnvVault's memory: it can list your repo and key names and push a `.env`, which automatic pull then brings to your other machines. It can't get values through the command line, but it could read your `.env` files directly anyway.
- A weak master password. Use a long, unique one, and keep it in your password manager.
- The plaintext `.env` and `.env.bak.*` files in your repos. They are created with mode `0600` on macOS, but **on Windows file permissions come from the folder's ACL** (your user profile is normally private to you). Delete old backups you don't need.
- The master password sitting briefly in JavaScript memory. JS strings can't be wiped; only the derived key is.
- Secrets in `.env.example` that don't look like secrets. The same-value check is a heuristic.
- Secrets kept in comments (for example a commented-out key). Comments aren't values, so the masked raw diff shows them.
- Someone seeing your screen while a raw diff or the editor shows values. Those values also stay in the renderer's memory until they are garbage-collected, for the same reason. A masked field still shows how long its value is.
- Metadata: repo names, file sizes and modification times are visible in the vault folder or repository.
- Old copies in a git vault's history, which keeps every version of every file for good (Drive's version history keeps some too). If your master password leaks, change the secrets themselves, not just the password: the old copies open with the old password.
- The git host's admins, or anyone who can push to the repository, deleting the vault or putting old copies back. A copy that went backwards shows as a conflict, as in a folder.
- Secrets pushed while a git vault was public. It's refused at the next unlock, but anything pushed meanwhile may have been copied (it's ciphertext, so the master password still protects it).
- A rollback on a machine that has never synced that repo (there is no earlier version to compare against).

## Setup

Requirements: Node.js 22 or newer, git, and either a folder synced between your machines (for example `My Drive/EnvVault` in Google Drive for desktop) or a private git repository (git 2.32 or newer). The [GitHub CLI](https://cli.github.com), signed in with `gh auth login`, lets EnvVault create and list GitHub repositories for you; it's optional.

```sh
npm install
npm run dev        # run the app with hot reload
npm test           # unit + integration tests
npm run build      # typecheck and build to out/
```

## Using it

1. **First machine:** choose your projects folder (the folder that contains your git repos) and the vault, then create the vault with a master password of at least 12 characters. The vault is either:
   - **a synced folder:** pick it with the folder picker;
   - **a private git repository:** **Create a new vault repository** makes a private one on your GitHub account through the GitHub CLI, or, without it, opens GitHub's new-repository page so you can paste its URL. **Select an existing one** lists your private GitHub repositories, and always takes a pasted URL (GitHub, GitLab, a server of your own). Use a repository just for the vault: EnvVault refuses one that holds other files, and one that isn't private.
2. **Other machines:** choose the same vault folder (wait for Drive to finish syncing first) or the same repository, and unlock it with the same password. EnvVault won't offer to create a vault where encrypted files already are.
3. Push and pull from the Repositories table. For a conflict, pick **Keep local** (push, overwriting the vault copy) or **Keep vault** (pull, backing up your local file first).

**Machine-specific keys:** some values differ between machines, such as a local path. Put `# envvault:local` on the line directly above such a key:

```sh
API_URL=https://api.example.com
# envvault:local
DATA_DIR=/Users/me/data
```

- A push uploads the key without its value (`DATA_DIR=` under the marker), so the value never leaves this machine, and changing it doesn't make the repo "local newer".
- A pull never overwrites or deletes a key that is marked in your `.env` or in the vault copy. It keeps your line and adds the marker if your file didn't have it. A marked key you don't have yet is written empty, and the pull dialog lists it so you can fill it in.
- If the vault marks a key but your `.env` doesn't, pushing uploads your value and drops the marker. The push dialog warns you first.
- A marked key must be assigned only once in the file.

**`.env.example` checks:** if a repo has a `.env.example`, the push and pull dialogs compare it with the `.env` you'll end up with (your file on push, the pulled result on pull). They warn, but never block, about:

- keys `.env.example` lists that your `.env` doesn't have. Keys commented out in the example count as optional;
- keys your `.env` has that `.env.example` doesn't document;
- values that are the same in both files and look like secrets, since `.env.example` is usually committed. A value looks like a secret if it is a URL with a password for a non-local host, 8+ characters under a key name such as `*_SECRET`, `*_TOKEN`, `*_PASSWORD` or `*_KEY`, or a long token-like string. Localhost URLs, ports, other plain values and browser-public keys (`VITE_`, `NEXT_PUBLIC_`, ...) are never flagged.

You can turn the checks off in Settings.

**Editing the vault copy:** click **Edit** on a repo to change its vault copy in a table of keys and values, without a local `.env`. On a repo with no `.env` and no vault copy, this creates one.

- Values are masked until you click **Show**. You can type or paste a new value into a masked field without displaying it. Multi-line values (such as a PEM key) need **Show** to edit.
- You can add, change and remove keys. Machine-specific keys are listed but have no value to edit, since the vault doesn't store one.
- Comments, blank lines, `export`, spacing and line endings stay as they are. A changed value keeps its line's prefix and trailing comment, and is quoted only as much as dotenv needs to read it back exactly.
- **Review changes** lists the key names that change. **Save to vault** writes a new version, unless the vault copy changed since you opened the editor; then reload and edit again.
- Saving never touches your local `.env` directly. A repo that has one shows "Vault newer" afterwards; automatic pull brings the edit in right away (or click **Pull** if it's off), keeping machine-specific values.

**Automatic pull:** while EnvVault is unlocked, it checks every minute (and right after you unlock or save an edit) for repos whose vault copy changed on another machine while your `.env` didn't, and pulls them for you. You get a toast, and if EnvVault isn't the focused window, a system notification. macOS shows notifications only for code-signed apps, so unsigned builds (including dev runs) badge the Dock icon with the number of pulls and bounce it once instead; the badge clears when you switch to EnvVault. On Windows the taskbar button flashes if a notification can't be shown.

- It never pulls a conflict, a rollback, or a repo whose `.env` isn't git-ignored or is tracked; those keep their **Pull** button.
- It creates a missing `.env` when the vault has a copy, including one you deleted.
- It saves a backup first, like a manual pull. A running dev server that watches `.env` may restart when the file changes.
- It stops when EnvVault locks; it doesn't keep the vault unlocked. Turn it off in Settings.

**Command line:** turn on **Allow command-line access** in Settings. Then, while EnvVault is running and unlocked, run `envvault` inside a repo in your projects folder:

```sh
envvault status                  # this repo's status (--all for every repo)
envvault push                    # shows the key changes, asks, then pushes
envvault push --dry-run          # only shows them, with a token...
envvault push --expect <token>   # ...that pushes exactly what you saw, if nothing changed since
```

- Run `npm link` in this repo once to put `envvault` on your PATH, or run `node out/cli/envvault.mjs`. `npm run build` builds it. In a packaged app it's in `app.asar.unpacked/out/cli/`, and needs Node 22 or newer.
- It shows key names only, never values.
- It pushes only one-sided changes. If the vault copy changed on another machine, it tells you to resolve it in the app.
- Options:
  - `--repo <name>` picks a repo by name instead of the current folder;
  - `--json` prints JSON;
  - `--yes` pushes without asking.
- Exit codes:
  - 0: done;
  - 1: refused or failed;
  - 2: usage;
  - 3: locked;
  - 4: EnvVault isn't running, or command-line access is off.
- It doesn't count as activity, so EnvVault still auto-locks; unlock it in the app.
- There's no pull command: automatic pull covers it.

**Claude Code skill:** with command-line access on, click **Install** next to _Claude Code skill_ in Settings. That writes `~/.claude/skills/envvault/SKILL.md`, so in any project you can ask Claude to check or push the repo's `.env`, or type `/envvault`.

- Claude runs `status` and `push --dry-run` on its own, shows you the key changes and warnings, and asks before the real push. Claude Code also asks you to approve that command.
- The skill points at this copy of EnvVault's command. If you move or update EnvVault, Settings shows it as out of date: click **Update**.
- The skill tells Claude never to read `.env` files. To enforce that for Claude's file tools, add `Read(**/.env)` and `Read(**/.env.bak.*)` to the `deny` list of your Claude Code permissions.
- If Claude Code runs commands in its sandbox and the command reports that EnvVault isn't reachable, allow EnvVault's socket in the sandbox settings, or let the command run outside the sandbox.

**Recovery:** there is no backdoor. If you lose the master password, the vault can't be opened. Your repos' plaintext `.env` files are your remaining copies, so you could start a new vault and push them again.

## Vault format

| File                | Contents                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta.json`         | `{ formatVersion: 1, vaultId, kdf: { alg: "argon2id", opslimit, memlimit, salt }, keyCheck }` (plaintext)                                                                                                                                           |
| `<repo>.env.enc`    | `"EVV1"` + 24-byte nonce + XChaCha20-Poly1305 ciphertext of `{ version, updatedAt, updatedBy, contentHash, envBase64 }`. The AAD is `envvault:v1:<repo>`. Repo names are lowercased. Machine-specific keys are stored as `KEY=` under their marker. |
| `.<file>.<hex>.tmp` | In-flight atomic writes. Stale ones are removed when you unlock.                                                                                                                                                                                    |

Anything else in the folder (for example Drive's `name (1).ext` conflict copies) is ignored.

In a git vault, the same files sit at the top of the repository's default branch, one commit per change, with no temp files. Anything else there (a README, folders) is ignored and kept.

## Settings

| Setting             | Default   | Notes                                                                   |
| ------------------- | --------- | ----------------------------------------------------------------------- |
| Projects folder     | —         | Repos are its direct subfolders that contain `.git`                     |
| Vault               | —         | A synced folder or a private git repository. Changing it locks EnvVault |
| Machine name        | hostname  | Shown to other machines as "updated by"                                 |
| Auto-lock           | 5 minutes | 1–120 minutes of inactivity                                             |
| .env.example checks | On        | Warnings in the push and pull dialogs                                   |
| Automatic pull      | On        | Every minute while unlocked; one-sided changes only                     |
| Command-line access | Off       | The `envvault` command and the Claude Code skill                        |

Settings are stored in Electron's `userData` folder (`config.json`). The per-machine sync state, which holds no secrets, is stored next to it in `state.json`. While command-line access is on, its socket (`cli.sock`, macOS) and token (`cli-token`) are there too, and a git vault's mirror is in `git-vaults/`.

## Development

```
src/
  core/      pure, unit-tested logic: crypto, .env diff, sync status, path safety
  main/      Electron main process: window, IPC, session, vault, repos, git, sync
  preload/   contextBridge API (sandboxed, bundled)
  shared/    channel names and types shared by all of them
  renderer/  Vue 3 UI
  cli/       the envvault command (plain Node; talks to the app over a socket)
tests/       Vitest: unit tests for core/, integration tests for main/
```

- `npm run lint`, `npm run typecheck` and `npm test` run in CI on macOS and Windows.
- `tests/sync.test.ts` exercises the real push/pull flows with real git and real crypto in temp folders, simulating two machines, over a vault folder and over a local git repository.
- To test without touching your real settings, run `npm run dev:profile -- [name]` (default name `test`). Each profile keeps its own settings and sync state in `envvault-<name>` next to the real data folder, and profiles can run side by side, so two of them can act as two "machines" on one computer. Add `--reset` to start the profile from scratch. A profile doesn't isolate the folders you pick in it, so choose a scratch vault folder and projects folder. Under the hood this sets `ENVVAULT_PROFILE=<name>`, which works only in unpackaged runs.

## Roadmap

- Unlock with the Bitwarden CLI.
- Run a command with the vault copy's values in its environment, without a `.env`.
- Change the master password.
- Packaged installers.

## License

[MIT](LICENSE)
