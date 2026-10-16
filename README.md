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
| In sync     | Local and vault are byte-identical                                                           | —                       |
| Local only  | Never pushed                                                                                 | Push                    |
| Local newer | Only you changed it since the last sync                                                      | Push                    |
| Vault newer | Only another machine changed it                                                              | Pull                    |
| Conflict    | Both changed, or they differ and this machine never synced them, or the vault went backwards | Keep local / Keep vault |
| Vault only  | In the vault, but the repo isn't in your projects folder                                     | —                       |
| No .env     | Nothing on either side                                                                       | —                       |

Every push and pull shows a confirmation with the **key names** that will be added, removed or changed, never their values. Pushing over a vault copy that someone else changed needs an explicit "overwrite anyway". A pull first saves your current `.env` as `.env.bak.<timestamp>`.

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
- **Env values never reach the renderer.** Only key names, statuses and metadata cross IPC.

**Data handling**

- The derived key lives only in the main process. Each operation gets its own copy, which is wiped when it finishes. The key is wiped on lock, on idle timeout (default 5 minutes), when the window closes, and when the computer sleeps or its screen locks.
- Repo names are restricted (ASCII, no `..`, no Windows device names). Every path is resolved and checked to stay inside its root after following symlinks, and a symlinked `.env` is refused.
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

**Recovery:** there is no backdoor. If you lose the master password, the vault can't be opened. Your repos' plaintext `.env` files are your remaining copies, so you could start a new vault and push them again.

## Vault format

| File                | Contents                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `meta.json`         | `{ formatVersion: 1, vaultId, kdf: { alg: "argon2id", opslimit, memlimit, salt }, keyCheck }` (plaintext)                                                                            |
| `<repo>.env.enc`    | `"EVV1"` + 24-byte nonce + XChaCha20-Poly1305 ciphertext of `{ version, updatedAt, updatedBy, contentHash, envBase64 }`. The AAD is `envvault:v1:<repo>`. Repo names are lowercased. |
| `.<file>.<hex>.tmp` | In-flight atomic writes. Stale ones are removed when you unlock.                                                                                                                     |

Anything else in the folder (for example Drive's `name (1).ext` conflict copies) is ignored.

## Settings

| Setting         | Default   | Notes                                               |
| --------------- | --------- | --------------------------------------------------- |
| Projects folder | —         | Repos are its direct subfolders that contain `.git` |
| Vault folder    | —         | Changing it locks EnvVault                          |
| Machine name    | hostname  | Shown to other machines as "updated by"             |
| Auto-lock       | 5 minutes | 1–120 minutes of inactivity                         |

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
- In development, `ENVVAULT_PROFILE=<name> npm run dev` gives the app its own settings folder, so two "machines" can run on one computer.

## Roadmap

- Unlock with the Bitwarden CLI.
- Reveal a `.env` in an auto-hiding view.
- Change the master password.
- Packaged installers.

## License

[MIT](LICENSE)
