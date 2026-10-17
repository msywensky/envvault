# EnvVault

[![CI](https://github.com/msywensky/envvault/actions/workflows/ci.yml/badge.svg)](https://github.com/msywensky/envvault/actions/workflows/ci.yml)

A desktop app (Electron + Vue 3 + TypeScript, macOS and Windows) that keeps each project's `.env` file in sync between your machines, through an **encrypted** vault folder such as a Google Drive folder. The sync folder only ever sees ciphertext. Plaintext stays in your repos, which EnvVault checks are git-ignored before it writes anything.

![Repositories view](docs/repos.png)

## How it works

```
Projects folder (each machine)          Vault folder (synced by Google Drive etc.)
  api/.env      ── push ──▶ encrypt ──▶   api.env.enc
  web/.env      ◀── pull ── decrypt ◀──   web.env.enc
                                          meta.json   (KDF params, salt, key check)
```

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
- The renderer never supplies file paths: folders come from the native picker in the main process, and repos are referred to by validated name.
- **Env values reach the renderer only when you click Show values in a raw pull diff.** Everything else that crosses IPC is key names, statuses and metadata. The raw diff:
  - arrives masked: the main process replaces every value, the continuation lines of multi-line values and any unrecognised line with `••••••••` before sending it. Key names, comments and blank lines are kept;
  - is sent with values only when you click **Show values**, and only for the exact local and vault content the preview showed;
  - contains only the changed lines plus 3 lines of context around them (other unchanged lines are sent as a count);
  - keeps its values only in the pull dialog (never the app's store), never logs them, and drops them after 60 seconds, when the window is hidden, when the dialog closes and when EnvVault locks.

**Data handling**

- The derived key lives only in the main process. Each operation gets its own copy, which is wiped when it finishes. The key is wiped on lock, on idle timeout (default 5 minutes), when the window closes, and when the computer sleeps or its screen locks.
- Repo names are restricted (ASCII, no `..`, no Windows device names). Every path is resolved and checked to stay inside its root after following symlinks, and a symlinked `.env` is refused.
- `.env.example` is read with the same checks as `.env` (no symlinks, at most 1 MiB), only to compare it. Only key names leave the main process.
- Values of machine-specific keys (`# envvault:local`) are never uploaded: the vault copy holds only their key names and markers, encrypted like everything else.
- Pulls are refused unless `.env` is git-ignored and **not tracked**. The backup and the temp file are named so `.env.bak.*` covers them, and they are checked too, so a crash never leaves secrets in a file git would commit.
- Writes are atomic: temp file in the same folder, fsync, rename (retried on Windows sharing violations). `meta.json` is created exclusively, so it can't overwrite a vault that synced in at the same moment.
- `meta.json` is treated as attacker-controlled:
  - KDF parameters must be between MODERATE and SENSITIVE (this stops downgrades and denial of service);
  - the key check is bound to the vault ID;
  - EnvVault refuses to create a new vault in a folder that already holds encrypted entries.
- git runs from an absolute path resolved through absolute `PATH` entries only, so a repo can't ship its own `git.exe`, and with `core.fsmonitor` disabled, so a repo's `.git/config` can't make git run commands.

## Threat model

**Protects against**

- The cloud provider, or anyone else with access to the vault folder, reading your secrets, tampering with them, swapping files between repos, rolling a file back, or weakening the KDF in `meta.json`.
- A stolen laptop while EnvVault is locked (the vault key is not stored anywhere).
- Accidentally committing pulled secrets (ignore and tracked checks).

**Does not protect against**

- Malware running as you on an unlocked machine.
- A weak master password. Use a long, unique one, and keep it in your password manager.
- The plaintext `.env` and `.env.bak.*` files in your repos. They are created with mode `0600` on macOS, but **on Windows file permissions come from the folder's ACL** (your user profile is normally private to you). Delete old backups you don't need.
- The master password sitting briefly in JavaScript memory. JS strings can't be wiped; only the derived key is.
- Secrets in `.env.example` that don't look like secrets. The same-value check is a heuristic.
- Secrets kept in comments (for example a commented-out key). Comments aren't values, so the masked raw diff shows them.
- Someone seeing your screen while a raw diff shows values. The values it showed also stay in the renderer's memory until they are garbage-collected, for the same reason.
- Metadata: repo names, file sizes and modification times are visible in the vault folder.
- A rollback on a machine that has never synced that repo (there is no earlier version to compare against).

## Setup

Requirements: Node.js 22 or newer, git, and a folder synced between your machines (for example `My Drive/EnvVault` in Google Drive for desktop).

```sh
npm install
npm run dev        # run the app with hot reload
npm test           # unit + integration tests
npm run build      # typecheck and build to out/
```

## Using it

1. **First machine:** choose your projects folder (the folder that contains your git repos) and the vault folder, then create the vault with a master password of at least 12 characters.
2. **Other machines:** wait for Drive to finish syncing, then choose the same vault folder and unlock it with the same password. EnvVault won't offer to create a vault in a folder that already holds encrypted files.
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

**Recovery:** there is no backdoor. If you lose the master password, the vault can't be opened. Your repos' plaintext `.env` files are your remaining copies, so you could start a new vault and push them again.

## Vault format

| File                | Contents                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta.json`         | `{ formatVersion: 1, vaultId, kdf: { alg: "argon2id", opslimit, memlimit, salt }, keyCheck }` (plaintext)                                                                                                                                           |
| `<repo>.env.enc`    | `"EVV1"` + 24-byte nonce + XChaCha20-Poly1305 ciphertext of `{ version, updatedAt, updatedBy, contentHash, envBase64 }`. The AAD is `envvault:v1:<repo>`. Repo names are lowercased. Machine-specific keys are stored as `KEY=` under their marker. |
| `.<file>.<hex>.tmp` | In-flight atomic writes. Stale ones are removed when you unlock.                                                                                                                                                                                    |

Anything else in the folder (for example Drive's `name (1).ext` conflict copies) is ignored.

## Settings

| Setting             | Default   | Notes                                               |
| ------------------- | --------- | --------------------------------------------------- |
| Projects folder     | —         | Repos are its direct subfolders that contain `.git` |
| Vault folder        | —         | Changing it locks EnvVault                          |
| Machine name        | hostname  | Shown to other machines as "updated by"             |
| Auto-lock           | 5 minutes | 1–120 minutes of inactivity                         |
| .env.example checks | On        | Warnings in the push and pull dialogs               |

Settings are stored in Electron's `userData` folder (`config.json`). The per-machine sync state, which holds no secrets, is stored next to it in `state.json`.

## Development

```
src/
  core/      pure, unit-tested logic: crypto, .env diff, sync status, path safety
  main/      Electron main process: window, IPC, session, vault, repos, git, sync
  preload/   contextBridge API (sandboxed, bundled)
  shared/    channel names and types shared by all three
  renderer/  Vue 3 UI
tests/       Vitest: unit tests for core/, integration tests for main/
```

- `npm run lint`, `npm run typecheck` and `npm test` run in CI on macOS and Windows.
- `tests/sync.test.ts` exercises the real push/pull flows with real git and real crypto in temp folders, simulating two machines.
- To test without touching your real settings, run `npm run dev:profile -- [name]` (default name `test`). Each profile keeps its own settings and sync state in `envvault-<name>` next to the real data folder, and profiles can run side by side, so two of them can act as two "machines" on one computer. Add `--reset` to start the profile from scratch. A profile doesn't isolate the folders you pick in it, so choose a scratch vault folder and projects folder. Under the hood this sets `ENVVAULT_PROFILE=<name>`, which works only in unpackaged runs.

## Roadmap

- Unlock with the Bitwarden CLI.
- Reveal a `.env` in an auto-hiding view.
- Change the master password.
- Packaged installers.

## License

[MIT](LICENSE)
