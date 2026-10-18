# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

EnvVault is an Electron + Vue 3 + TypeScript desktop app (macOS and Windows) that syncs each repo's `.env` between machines through an encrypted vault folder (e.g. a Google Drive folder). README.md holds the full security design, threat model and vault file format; read it before changing anything in crypto, IPC or file handling.

Requirements: Node 22+ (`engines`), and `git` on PATH (the integration tests and the app both shell out to it).

## Commands

```sh
npm run dev                                  # dev build with hot reload
npm run dev:profile -- alice --reset         # dev with isolated settings (name optional, --reset optional)
npm test                                     # all Vitest tests (tests/**/*.test.ts)
npx vitest run tests/paths.test.ts           # one file
npx vitest run tests/sync.test.ts -t "pull"  # tests matching a name
npm run lint                                 # eslint, --max-warnings 0 (warnings fail)
npm run typecheck                            # tsc for the node side + vue-tsc for the renderer
npm run build                                # typecheck, electron-vite build to out/, then build:cli
npm run build:cli                            # the envvault command only: out/cli/envvault.mjs
npm start                                    # run the production build (strict CSP, file://)
npm run format                               # prettier
```

- Prettier (single quotes, no semicolons, width 100, no trailing commas) runs inside ESLint, so formatting problems fail `npm run lint`. `.gitattributes` forces LF line endings.
- CI (`.github/workflows/ci.yml`) runs `npm ci --ignore-scripts`, lint, test and build on macOS and Windows. `--ignore-scripts` skips our `postinstall` (Electron binary download, electron-builder native deps), which lint, tests and build don't need; Electron 44 no longer honours `ELECTRON_SKIP_BINARY_DOWNLOAD`.
- A Husky pre-commit hook (`.husky/pre-commit`) runs `lint-staged`: ESLint with `--max-warnings 0` on staged `.ts/.vue/.js` files. Husky installs via `prepare`, so `npm ci --ignore-scripts` in CI skips it. CI runs lint, tests and the build on every push to main and every pull request.
- `ENVVAULT_PROFILE=<name>` (unpackaged runs only, i.e. `npm run dev` / `npm start`) gives the run its own `userData` folder (`<appData>/envvault-<name>`), so two "machines" can share one vault folder. `src/main/profile.ts` silently ignores names that don't match `PROFILE_RE` (`src/shared/cli.ts`, also used by the CLI's `--profile`) and falls back to the real settings, so use `npm run dev:profile` (`scripts/dev-profile.mjs`), which validates the name and refuses instead. Its regex must stay in sync with `PROFILE_RE`.
- To inspect the running app, start it with `npx electron-vite dev --remoteDebuggingPort 9222` (or `npx electron . --remote-debugging-port=9223` after a build) and drive `window.envvault` over CDP. When testing that CSP blocks `eval`, pass `allowUnsafeEvalBlockedByCSP: false` to `Runtime.evaluate`; it defaults to true.
- Commit messages use conventional-commit style with a scope: `feat(core): ...`, `feat(main): ...`, `feat(ui): ...`, `chore: ...`.

## Architecture

Six source areas with import boundaries **enforced by ESLint** (`eslint.config.mjs`), so a wrong import fails lint:

- `src/core/` — pure logic (crypto, `.env` parsing/key diff, line diff, three-way sync status, machine-specific keys, path safety). No Electron, `fs` or `child_process` (`node:crypto` and `node:path` are allowed); must not import main or renderer. Unit-tested.
- `src/main/` — Electron main process. Owns the key, all file system and git access.
- `src/preload/` — sandboxed; may import only `electron` and relative files (they get bundled). Exposes named functions as `window.envvault`, never `ipcRenderer` or IPC event objects.
- `src/shared/` — channel names and types used by all processes. Relative imports only (no packages, not even zod), because it reaches the sandboxed preload and the renderer. Request schemas therefore live in `src/main/schemas.ts`, not here.
- `src/renderer/` — Vue 3 UI. No Node/Electron imports, nothing from core/main/preload; talks to the system only via `window.envvault`. `v-html` is banned.
- `src/cli/` — the `envvault` command, bundled by `vite.cli.config.mts` into one file for plain Node. May import only `node:` built-ins and relative files (core, shared), nothing from main/preload/renderer; it talks to the app only over the socket (see Command line below).

### IPC

Every call goes through `handle()` in `src/main/ipc.ts`, which checks the sender is the app's own window/main frame/URL, validates the payload with a strict zod schema, and always returns a `Result` envelope (`{ok, data}` / `{ok, error: {code, message}}`). Throw `AppError(code, message)` (`src/main/errors.ts`) for expected failures; error codes live in `src/shared/result.ts`. Error messages must never echo input: zod failures become a generic `BAD_REQUEST`, Node fs errors become `FS_ERROR` with only the errno, anything else becomes `INTERNAL`.

Adding a channel touches five places:

1. `src/shared/channels.ts` — `CH` entry
2. `src/shared/api.ts` — `Responses` map and `EnvVaultApi` method
3. `src/main/schemas.ts` — request schema (`z.strictObject`, or `NoArgs` for no payload)
4. `src/main/handlers.ts` — `handle(CH.x, ...)`
5. `src/preload/index.ts` — the `api` function

Steps 1, 2, 3 and 5 are type-checked against each other, but **forgetting step 4 still compiles**: the call fails at runtime ("No handler registered"), which the renderer reports as "Lost contact with the app".

Renderer side (`src/renderer/src/store.ts`, a plain reactive store, no Pinia):

- Wrap calls as `call(() => window.envvault.x(...))` or `run(...)` (which toasts errors). They take a **function**, not a promise, so synchronous throws are caught too.
- Arguments must be plain objects. A Vue reactive proxy makes contextBridge throw "An object could not be cloned" synchronously; copy fields out first (see `SyncDialog.vue`).
- TypeScript narrowing is lost inside the arrow, so capture narrowed values before it.

### Session, key and concurrency

- `src/main/session.ts` holds the derived key. Use `session.withKey(fn)`, which hands `fn` a private copy that is wiped afterwards; never hold the session key directly. The key is wiped on lock, idle timeout, window close, sleep/screen lock, and vault-folder change.
- `exclusive()` (`src/main/mutex.ts`) serializes every write or session change. It is **not re-entrant**: never call it from inside another `exclusive()` callback, and don't add it inside `src/main/sync.ts` (the handlers already wrap those calls). Write handlers take the key _inside_ `exclusive()`, so a queued operation fails with `LOCKED` rather than using a stale key. `state.ts` and `config.ts` serialize their own read-modify-write with separate `createSerial()` queues.
- Argon2id key derivation runs in a worker (`kdf.ts` + `kdf.worker.ts`, imported via electron-vite's `?modulePath`) so the main thread doesn't freeze.

### Push/pull flow (`src/main/sync.ts`)

- **Two steps.** `previewPush`/`previewPull` return a key-name diff plus `expected: {localHash, vaultHash}`. The commit (`push`/`pull`) re-reads both sides and refuses with `LOCAL_CHANGED`/`VAULT_CHANGED` if the hashes differ from what the user reviewed. Pushing over a vault copy that changed elsewhere also needs `overwriteConfirmed`.
- **Plaintext handling.** `withSnapshot` reads the local file and the decrypted vault payload, and zero-fills the plaintext buffers afterwards.
- **Status** comes from `core/status.ts`: local vs vault vs this machine's last sync. The last sync is stored per vault in `state.json` via `src/main/state.ts`.
- **The vault.** `src/main/vault.ts` is the only module that touches the vault folder. Everything else goes through a `Vault` object (`state`, `create`, `open`, `list`, `read`, `write`):
  - `vaultAt(path)` binds one to a folder;
  - `configuredVault()` returns the one chosen in Settings, or null;
  - `requireVault()` is the same but throws `NOT_CONFIGURED`.

  The path functions behind them aren't exported. `sync.ts`'s `Configured` omits `vaultPath`, so sync can't reach the vault by path.

- **Entry IDs.** A repo's vault entry ID is `entryId(name)` = the **lowercased** repo name (`src/main/vault.ts`). It is used for the file name, the encryption AAD and the `state.json` key.
- **Errors in the list.** `listRepos` turns per-repo failures (a tampered entry, a symlinked `.env`) into rows with `status: 'error'` instead of failing the whole list.
- **Raw diff.** `pullRawDiff` returns a line diff (`core/linediff.ts`) from the local `.env` to the vault copy, with only changed lines plus 3 context lines. It is masked in main (`maskEnvLines` in `core/envdiff.ts`, which shares `parseEnv`'s scanner; comments are not values and pass through) unless the request has `values: true`, which makes it the one flow that returns env values. It takes the same `expected` as `pull` and refuses with `LOCAL_CHANGED`/`VAULT_CHANGED` too, so it always matches the preview.
- **Machine-specific keys.** A `# envvault:local` line directly above an assignment marks that key (`src/core/localkeys.ts`; byte wrappers and error mapping in `src/main/localkeys.ts`). Status and push use `projectEnv`, which blanks marked values to a canonical `KEY=` so differently formatted files on two machines hash the same. `Snapshot.localHash` stays the hash of the raw bytes, so `expected` catches any edit; `syncedHash` is what's compared with the vault. Pulls and `pullRawDiff` use `mergePull`: the vault copy with local lines kept for keys marked on either side. Both return `null` when there is nothing to change, meaning "use the original bytes", so files without markers still sync byte for byte. A marked key assigned twice fails with `ENV_DUPLICATE_KEY`.
- **`.env.example` checks** (`src/core/example.ts`, `checkExample` in `src/main/sync.ts`). Advisory only. Both previews compare the example with the `.env` you'll end up with: the raw local file on push (machine-specific values included), the merged result on pull. They return key names in `example`. The check isn't part of `expected`, the commit steps never read the example, and a file that can't be read becomes `status: 'unreadable'` instead of an error. `isTracked` runs only when there are same-value warnings, so push previews still work without git. Skipped when the `checkExample` setting is off.
- **Editing the vault copy** (`openEditor`/`saveEdit` in `src/main/sync.ts`, pure logic in `src/core/envedit.ts`).
  - `decodeValue`/`encodeValue` follow dotenv 16's parser exactly. `tests/envedit.test.ts` checks them against the real `dotenv.parse`, a pinned devDependency.
  - `applyEdits` splices changes into the original text, so untouched lines stay byte for byte. Machine-specific values can't be set from it.
  - A save refuses with `VAULT_CHANGED` if the copy changed since it opened (`expectedVaultHash`), and runs `syncedBytes` like a push.
  - It never touches the local `.env` or `state.json`'s last sync, so a local `.env` shows vault-newer and is pulled as usual.
  - `src/core/envlines.ts` is the line-level scanner shared with `localkeys.ts`.
- **Automatic pull** (`src/main/autopull.ts`, `autoPull` in `src/main/sync.ts`, setting `autoPull`, default on).
  - `runAutoPull` lists repos and pulls each `vault-newer` one through `exclusive(() => session.withKey(...))`, one repo per `exclusive()`.
  - `autoPull` re-checks inside it: `computeStatus` must say `vault-newer` and `ignoreStatus` must pass. It then shares `applyPull` with `pull`.
  - It runs on a 60 s interval and on `kickAutoPull()` after unlock, a Settings save with it on, and a changed editor save. `kickAutoPull` is always called after `exclusive()` has resolved, never inside it.
  - Pulled rows go to the renderer as `EV.autoPulled`. When the window isn't focused, `src/main/notify.ts` also shows a system notification. If that fails or isn't supported, it falls back to a Dock badge and one bounce (macOS) or a flashing taskbar button (Windows), cleared on focus.
  - macOS delivers notifications only for code-signed apps. Dev runs (ad-hoc signed Electron) and the unsigned build get Electron's `failed` event (`UNErrorDomain error 1`), so on macOS the Dock fallback is what you'll actually see. `show()` returning means nothing: listen for `failed`.
- **Command line** (`src/cli/`, `src/main/cliserver.ts`, `src/main/clicommands.ts`, protocol in `src/shared/cli.ts`, setting `cliAccess`, default off).
  - **Transport:** `cliserver.ts` listens only while the setting is on (`setCliAccess`, called at startup and after every Settings save).
    - The address comes from `cliEndpoint(userData)` (`src/core/cliendpoint.ts`, shared with the CLI): a `0600` Unix socket on macOS, a named pipe hashed from `userData` on Windows.
    - Every request carries the token from `<userData>/cli-token`: 32 random bytes, replaced on each start, compared with `timingSafeEqual`. A Windows pipe grants Everyone read by default, so the token is what protects it.
    - One JSON line per connection, at most 64 KiB, answered with one `Result` line. Same rules as IPC: strict zod schemas, `failureOf` (`errors.ts`) for errors, no echoed input.
  - **Commands** (`clicommands.ts`): `status`, `previewPush` and `push`.
    - A repo is named, or found from the CLI's working directory by `repoNameAt` (`repos.ts`), which uses the path only to work out the name.
    - `push` is `sync.push` inside `exclusive(() => session.withKey(...))` with `overwriteConfirmed: false`, so it's one-sided only.
    - Pushes that changed the vault copy go to the renderer as `EV.cliPushed` rows, patched in like automatic pulls.
  - **The CLI** (`src/cli/main.ts`): two steps, like the app. `push --dry-run` prints the preview's `expected` as a token, and `push --expect <token>` sends it back. Exit codes: 0 done, 1 refused or failed, 2 usage, 3 `LOCKED`, 4 `CLI_UNAVAILABLE`.
  - **The Claude Code skill:** `src/core/skill.ts` (text), `src/main/skill.ts` (install, status, remove in `~/.claude/skills/envvault`).
    - It pre-approves only `status` and `push --dry-run`, so the real push still goes through Claude Code's permission prompt.
    - Its command is `node "<path to out/cli/envvault.mjs>"`, with `app.asar.unpacked` when packaged and `--profile` under a dev profile. Settings shows it as different when that changes.
    - It is replaced only on request, and removed only if it carries `SKILL_MARKER`.
- **Pull safety.** Pulls require `.env` and `.env.bak.*` to be git-ignored and `.env` to be untracked. The backup is written from the bytes already read, and the temp file is named `.env.bak.tmp-<hex>` so the same ignore rule covers it. Writes are atomic via `src/main/fsutil.ts`.

### Invariants to preserve

- Env **values** never get logged, and cross IPC only through:
  - `repo:pullRawDiff` with `values: true` (the user's **Show values** click). The renderer keeps them only in `SyncDialog`'s local `rawValues` ref (never the store) and shows them only in `RawDiffView.vue`, which hides them again;
  - `repo:openEditor` (main → renderer) and `repo:saveEdit` (renderer → main, changed values only). The renderer keeps them only in `EnvEditorDialog.vue`'s local `rows`, masked until shown and re-masked when the window is hidden or the editor is idle.

  Every other channel, and the envvault socket, carries only key names, statuses, hashes and metadata. Error messages from the editor flows never contain keys or values (`EditError` messages are fixed strings). `console.error` is the only allowed console call (lint enforces it). When logging a caught error, log only `err.name`, never the error object or its message (V8's `JSON.parse` errors quote their input).

- Background work must never make the renderer call IPC: every request resets the idle auto-lock (`ipcHooks.onAuthorizedCall`), so it would keep the vault unlocked. That's why `EV.autoPulled` and `EV.cliPushed` carry the updated rows and the renderer patches `store.repos` instead of refetching. Main-side background work uses `session.withKey`, which doesn't touch the timer.
- Requests from the envvault socket never reset the idle timer either: they don't go through `ipcHooks`, so a script or Claude polling `status` can't keep the vault unlocked. Don't add a `touch()` there.
- The renderer never supplies file paths. Folders come from the native picker in main; repos are referenced by validated name (`isValidRepoName`), and paths are resolved with `resolveInside`/`isInside` (`src/core/paths.ts`).
- `meta.json` in the vault is attacker-controlled. Read it only through `parseMeta` (`src/core/crypto.ts`), which bounds the KDF params to `KDF_DEFAULTS`..`KDF_MAX`; the key check is bound to the `vaultId`.
- Run git only through `git()` in `src/main/git.ts`. It resolves an absolute git path from absolute PATH entries only, so a repo can't supply its own `git.exe`, and passes `-c core.fsmonitor=false`.
- The CSP is injected as a `<meta>` tag by a plugin in `electron.vite.config.ts` (strict in production, relaxed only for Vite dev). Don't add a second CSP header. Production `style-src 'self'` also blocks `style="..."` attributes, so put styles in `src/renderer/src/assets/main.css` (`:style` bindings are fine).

## Scope

v1 is manual-password unlock only. The `envvault` command does `status` and `push` only: no pull, no unlock. Bitwarden CLI unlock and a run mode (`envvault run`, starting a command with the vault copy's values in its environment) are planned follow-ups. Run mode would send values to another process, a new path beyond the raw diff and the editor, so it needs an explicit design and a README threat-model update first.

Packaging (`electron-builder.yml`) is deliberately minimal:

- macOS (dmg) and Windows (nsis) only. `build:linux` has no config and isn't supported.
- Only `out/` is shipped. electron-builder adds `package.json` and the production dependencies itself.
- `out/cli/**` is `asarUnpack`ed, because the envvault command runs under plain Node, which can't read `app.asar`.
- No auto-update (`publish: null`), unsigned, not notarized. Unsigned also means macOS system notifications fail (see automatic pull above).
- The macOS entitlements allow only V8's JIT (needed for libsodium's WebAssembly).
- `npm run build:unpack` produces `dist/win-unpacked/`. The packaged app ignores `ENVVAULT_PROFILE` and keeps its data in `%APPDATA%\envvault`.
- The Argon2 worker loads from inside `app.asar` (verified on Windows).
- Never extract files from `app.asar` into the repo root (`asar extract-file` writes to the current directory and will overwrite `package.json`).

## Tests

- `tests/{cliendpoint,crypto,envdiff,envedit,example,linediff,localkeys,paths,status}.test.ts` unit-test `src/core/`. Most crypto tests use small Argon2 params; two deliberately use the real `KDF_DEFAULTS` and `KDF_MAX` (a few seconds) to prove the WASM build can allocate them.
- `tests/sync.test.ts` is an integration test of the main-process flows with real temp folders, real `git` and real crypto:
  - It mocks only `electron` (`app.getPath` returns a per-machine `userData`) and `../src/main/kdf` (fast KDF params).
  - Two machines are simulated by `vi.resetModules()` and re-importing the main modules with a different `userData`.
  - The symlink test is skipped on Windows.
- `tests/cli.test.ts` runs the envvault command (`src/cli/main.ts`) against the real socket server with a fake command table, in a short `/tmp` folder because Unix socket paths are limited to about 104 bytes. `tests/skill.test.ts` covers the skill text and installing it into a temp folder.
