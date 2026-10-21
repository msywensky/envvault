# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

EnvVault is an Electron + Vue 3 + TypeScript desktop app (macOS and Windows) that syncs each repo's env files (its root `.env`, in a monorepo the `.env` in each package's folder, and variants such as `.env.local` where the repo's settings say so) between machines through an encrypted vault: a synced folder (e.g. a Google Drive folder) or a private git repository. `docs/security.md` holds the full security design, threat model and vault file format; read it before changing anything in crypto, IPC or file handling. README.md is the user guide, with a one-paragraph security summary that links to it.

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
npm run check                                # lint + typecheck, then tests: failures and a summary only
npm run build                                # typecheck, electron-vite build to out/, then build:cli
npm run build:cli                            # the envvault command only: out/cli/envvault.mjs
npm start                                    # run the production build (strict CSP, file://)
npm run format                               # prettier
```

- Prettier (single quotes, no semicolons, width 100, no trailing commas) runs inside ESLint, so formatting problems fail `npm run lint`. `.gitattributes` forces LF line endings.
- CI (`.github/workflows/ci.yml`) runs `npm ci --ignore-scripts`, lint, test and build on macOS and Windows. `--ignore-scripts` skips our `postinstall` (Electron binary download, electron-builder native deps), which lint, tests and build don't need; Electron 44 no longer honours `ELECTRON_SKIP_BINARY_DOWNLOAD`.
- A Husky pre-commit hook (`.husky/pre-commit`) runs `lint-staged`: ESLint with `--max-warnings 0` on staged `.ts/.vue/.js` files. Husky installs via `prepare`, so `npm ci --ignore-scripts` in CI skips it. CI runs lint, tests and the build on every push to main and every pull request.
- `ENVVAULT_PROFILE=<name>` (unpackaged runs only, i.e. `npm run dev` / `npm start`) gives the run its own `userData` folder (`<appData>/envvault-<name>`), so two "machines" can share one vault folder. `src/main/profile.ts` silently ignores names that don't match `PROFILE_RE` (`src/shared/cli.ts`, also used by the CLI's `--profile`) and falls back to the real settings, so use `npm run dev:profile` (`scripts/dev-profile.mjs`), which validates the name and refuses instead. Its regex must stay in sync with `PROFILE_RE`.
- To inspect the running app, start it with `npx electron-vite dev --remoteDebuggingPort 9222` (or `npx electron . --remote-debugging-port=9223` after a build) and drive `window.envvault` over CDP. The packaged app refuses those switches and has DevTools off (`src/main/index.ts`, `window.ts`), so CDP works only unpackaged. When testing that CSP blocks `eval`, pass `allowUnsafeEvalBlockedByCSP: false` to `Runtime.evaluate`; it defaults to true.
- Commit messages use conventional-commit style with a scope: `feat(core): ...`, `feat(main): ...`, `feat(ui): ...`, `chore: ...`.
- Run `npm run check` (or `/check`) after changing code and before calling work done. Claude Code hooks (`.claude/settings.json`, `scripts/claude-hook.mjs`) lint each edited file, typecheck at the end of a turn that edited code, and block env file reads and destructive git/rm commands. `docs/claude-orchestration-plan.md` describes the setup.
- Navigation: use cymbal for TypeScript (`investigate`, `trace`, `impact`, `changed`, `outline`, `show`) before grep. It does not index `.vue`; use Grep/Read for renderer components. For your own changes, `cymbal changed --base "$(git merge-base origin/main HEAD)" --no-federate` lists what they touch; with several worktrees, pass `--no-federate` to every cymbal command. Reviews (`/ev-review`) compute their base from the PR, since stacked PRs aren't based on `main`.

## Architecture

Six source areas with import boundaries **enforced by ESLint** (`eslint.config.mjs`), so a wrong import fails lint:

- `src/core/` — pure logic (crypto, `.env` parsing/key diff, line diff, three-way sync status, machine-specific keys, path safety, git remote URLs). No Electron, `fs` or `child_process` (`node:crypto` and `node:path` are allowed); must not import main or renderer. Unit-tested.
- `src/main/` — Electron main process. Owns the key, all file system and git access.
- `src/preload/` — sandboxed; may import only `electron` and relative files (they get bundled). Exposes named functions as `window.envvault`, never `ipcRenderer` or IPC event objects.
- `src/shared/` — channel names and types used by all processes. Relative imports only (no packages, not even zod), because it reaches the sandboxed preload and the renderer. Request schemas therefore live in `src/main/schemas.ts`, not here.
- `src/renderer/` — Vue 3 UI. No Node/Electron imports, nothing from core/main/preload; talks to the system only via `window.envvault`. `v-html` is banned.
- `src/cli/` — the `envvault` command, bundled by `vite.cli.config.mts` into one file for plain Node. May import only `node:` built-ins and relative files (core, shared), nothing from main/preload/renderer; it talks to the app only over the socket (see the command-line section in `src/main/CLAUDE.md`).

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
- Settings (`SettingsView.vue`) has three tabs, `SettingsGeneral`, `SettingsSync` and `SettingsCommandLine`, all mounted (`v-show`) so switching keeps edits. Each tab saves on its own (`SaveBar.vue`, above and below it). `settings:save` takes every field (`SettingsRequest`), so a tab saves through `saveSettings(changes)` in `store.ts`, which sends the other tabs' fields as saved; never send a whole form's draft. `store.settingsTab` picks the tab from elsewhere.

### Session, key and concurrency

- `src/main/session.ts` holds the derived key. Use `session.withKey(fn)`, which hands `fn` a private copy that is wiped afterwards; never hold the session key directly. The key is wiped on lock, idle timeout, window close, sleep/screen lock, and a change of vault. The idle timeout is the `autoLock` setting (default on, `autoLockMinutes`); `autoLockAfter()` (`config.ts`) gives the session `null` when it's off. Settings asks to confirm a warning before turning it off.
- `exclusive()` (`src/main/mutex.ts`) serializes every write or session change. It is **not re-entrant**: never call it from inside another `exclusive()` callback, and don't add it inside `src/main/sync.ts` (the handlers already wrap those calls). Write handlers take the key _inside_ `exclusive()`, so a queued operation fails with `LOCKED` rather than using a stale key. `state.ts` and `config.ts` serialize their own read-modify-write with separate `createSerial()` queues.
- Argon2id key derivation runs in a worker (`kdf.ts` + `kdf.worker.ts`, imported via electron-vite's `?modulePath`) so the main thread doesn't freeze.
- A new vault's password needs 12 characters and a zxcvbn-ts score of 3 (`core/password.ts`, `PASSWORD_WEAK`), with the machine's, folders' and repository's names as context. `vault.ts` checks it before deriving the key. The dictionaries load on first use, and Levenshtein matching stays off: it made one check take up to a second on the main thread. Only the first 128 characters are scored (`maxLength`; zxcvbn's 256 took over 2 s on Windows CI).

### Where the rest is documented

Detailed guidance lives next to the code. Read the relevant file before changing that area:

- `src/main/CLAUDE.md` — push/pull flow, the `Vault` object, setup codes, entries, snapshots and compare-and-swap, repo settings, conflicts and merging, the editor, automatic pull, CLI server, mini mode, pull safety.
- `src/main/store/CLAUDE.md` — `VaultStore` contract, folder/memory/git stores, git vaults and the privacy check.
- `src/core/CLAUDE.md` — pure-logic contracts: crypto formats, env parsing/editing, merge, paths, password.
- `tests/CLAUDE.md` — test layout, mocks and fixtures.
- `docs/security.md` — security design, threat model and vault file format.

### Invariants to preserve

- Env **values** never get logged, and cross IPC only through:
  - `repo:pullRawDiff` with `values: true` (the user's **Show values** click). The renderer keeps them only in `SyncDialog`'s local `rawValues` ref (never the store) and shows them only in `RawDiffView.vue`, which hides them again;
  - `repo:mergeValues` (the Resolve dialog's **Show values** click). The renderer keeps them only in `ResolveDialog.vue`'s local `values` ref and drops them like the raw diff's;
  - `repo:openEditor` (main → renderer) and `repo:saveEdit` (renderer → main, changed values only). The renderer keeps them only in `EnvEditorDialog.vue`'s local `rows`, masked until shown and re-masked when the window is hidden or the editor is idle.

  Every other channel, and the envvault socket, carries only key names, statuses, hashes and metadata. Error messages from the editor flows never contain keys or values (`EditError` messages are fixed strings). `console.error` is the only allowed console call (lint enforces it). When logging a caught error, log only `err.name`, never the error object or its message (V8's `JSON.parse` errors quote their input).

- The **setup code** is a credential (with the password it opens a copy of the vault). It crosses IPC only in the `session:createVault` reply, `session:unlock` requests and the `vault:showSetupCode` reply. It's never logged, never in `store` or an error message, and the renderer keeps it only in component-local refs (`LockScreen.vue`, `SetupCodeField.vue`), cleared once used, on lock (`lockEpoch`), when hidden, and when you leave Settings' General tab. The vault's secret never leaves main except as that code, and stores never see it (lint bans `secrets` and `core/setupcode` there). The app still grants no clipboard permission: the code is shown with `user-select: all` for copying by hand.
- Background work must never make the renderer call IPC: every request resets the idle auto-lock (`ipcHooks.onAuthorizedCall`), so it would keep the vault unlocked. That's why `EV.autoPulled`, `EV.cliPushed` and `EV.repoStatus` carry the updated rows and the renderer patches `store.repos` instead of refetching. Main-side background work uses `session.withKey`, which doesn't touch the timer.
- Requests from the envvault socket never reset the idle timer either: they don't go through `ipcHooks`, so a script or Claude polling `status` can't keep the vault unlocked. Don't add a `touch()` there.
- Merge bases (`src/main/bases.ts`) are only ever stored encrypted, open only while unlocked, and never leave the main process: the renderer gets key names and change labels from them, never content.
- A store (`src/main/store/`) only ever sees encrypted entries and the plaintext `meta.json`, never a key or a value. ESLint stops store modules from importing `session`, `kdf`, `sync`, `vault`, `localkeys`, `secrets`, `bases` and the crypto, setup-code, env-diff, editor and merge modules of `core`.
- The renderer never supplies a file system path. Folders come from the native picker in main; repos are referenced by validated name (`isValidRepoName`), a repo's env files by a validated path inside it (`EnvPath`, `isEnvPath`; never absolute), repo settings by patterns (`patternProblem`; they only choose among files discovery found inside the repo, never name a path to read) and vault names (`RepoName`), and paths are resolved with `resolveInside`/`isInside` (`src/core/paths.ts`) and `resolveEnvDir`, which refuses a symlinked folder. A git vault's URL is the one location the renderer sends (`setGitVault`, or a listed repo's URL round-tripping), and main parses it with `parseGitRemote` before git sees it: `https://`, `ssh://` or `user@host:path` only, no credentials, local paths, `file://`, other transports, whitespace or leading `-`. Its error messages never quote the URL. `GitStore` parses it again, so a hand-edited `config.json` can't reach git either.
- `meta.json` in the vault is attacker-controlled. Read it only through `parseMeta` (`src/core/crypto.ts`), which bounds the KDF params to `KDF_DEFAULTS`..`KDF_MAX`; the key check is bound to the `vaultId`.
- Run git only through `git()`/`runGit()` in `src/main/git.ts` (gh through `runGh` in `gh.ts`). Executables come from `findExecutable` (`src/main/exec.ts`), which uses absolute PATH entries only, so a repo can't supply its own `git.exe`. `git()` passes `-c core.fsmonitor=false`; git vault commands add the hardening and the privacy check's anonymous environment described in `src/main/store/CLAUDE.md`. Keep both lists intact.
- A git vault's commits carry no machine name or user identity, only `EnvVault`; `updatedBy` stays inside the ciphertext.
- The CSP is injected as a `<meta>` tag by a plugin in `electron.vite.config.ts` (strict in production, relaxed only for Vite dev). Don't add a second CSP header. Production `style-src 'self'` also blocks `style="..."` attributes, so put styles in `src/renderer/src/assets/main.css` (`:style` bindings are fine).

## Scope

Env files: `.env` and `.env.<suffix>`, in any folder, chosen by each repo's rules (every `.env` by default). Not yet: other names (`*.env`), env files inside submodules, pushing or pulling several files in one review, an `.env.example` check for variants, repos inside plain folders of the projects folder (`projects/acme/api`), automatic pull or "pull only" per repo, suggesting Sync as for git worktrees, noticing `settings.enc` deleted or rolled back, and unmarking a machine-specific key from the app.

Setup codes don't yet cover: upgrading a format 1 vault (re-key every entry, and old copies stay in history), changing the password or the secret, pairing a new machine through the vault or the Bitwarden CLI, or clearing the clipboard.

Git vaults don't yet cover: S3-compatible stores, choosing a branch, pruning history, `cat-file --batch` for many repos, or unlocking without network (`check()` needs the remote).

v1 is manual-password unlock only. The `envvault` command does `status` and `push` only: no pull, no unlock. Bitwarden CLI unlock and a run mode (`envvault run`, starting a command with the vault copy's values in its environment) are planned follow-ups. Run mode would send values to another process, a new path beyond the raw diff and the editor, so it needs an explicit design and a threat-model update in `docs/security.md` first.

Packaging (`electron-builder.yml`) is deliberately minimal:

- macOS (dmg) and Windows (nsis) only. `build:linux` has no config and isn't supported.
- Only `out/` is shipped. electron-builder adds `package.json` and the production dependencies itself.
- `out/cli/**` is `asarUnpack`ed, because the envvault command runs under plain Node, which can't read `app.asar`.
- Electron fuses (`electronFuses`) turn off run-as-node, `NODE_OPTIONS` and `--inspect`, and load only an integrity-checked `app.asar`. `grantFileProtocolExtraPrivileges` stays on: the renderer loads over `file://`, and without it the window is blank. `resetAdHocDarwinSignature` re-signs ad hoc after the flip: electron-builder signs only when it finds an identity, and Apple Silicon kills an app whose framework no longer matches its signature (`Code Signature Invalid` in `IsRunAsNodeEnabled`).
- No auto-update (`publish: null`), unsigned, not notarized. Unsigned also means macOS system notifications fail (see automatic pull in `src/main/CLAUDE.md`).
- The macOS entitlements allow only V8's JIT (needed for libsodium's WebAssembly).
- `npm run build:unpack` produces `dist/win-unpacked/`. The packaged app ignores `ENVVAULT_PROFILE` and keeps its data in `%APPDATA%\envvault`.
- The Argon2 worker loads from inside `app.asar` (verified on Windows).
- Never extract files from `app.asar` into the repo root (`asar extract-file` writes to the current directory and will overwrite `package.json`).
