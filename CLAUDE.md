# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

EnvVault is an Electron + Vue 3 + TypeScript desktop app (macOS and Windows) that syncs each repo's `.env` between machines through an encrypted vault: a synced folder (e.g. a Google Drive folder) or a private git repository. README.md holds the full security design, threat model and vault file format; read it before changing anything in crypto, IPC or file handling.

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

- `src/core/` — pure logic (crypto, `.env` parsing/key diff, line diff, three-way sync status, machine-specific keys, path safety, git remote URLs). No Electron, `fs` or `child_process` (`node:crypto` and `node:path` are allowed); must not import main or renderer. Unit-tested.
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

- `src/main/session.ts` holds the derived key. Use `session.withKey(fn)`, which hands `fn` a private copy that is wiped afterwards; never hold the session key directly. The key is wiped on lock, idle timeout, window close, sleep/screen lock, and a change of vault. The idle timeout is the `autoLock` setting (default on, `autoLockMinutes`); `autoLockAfter()` (`config.ts`) gives the session `null` when it's off. Settings asks to confirm a warning before turning it off. Sleep, screen lock and window close always lock.
- `exclusive()` (`src/main/mutex.ts`) serializes every write or session change. It is **not re-entrant**: never call it from inside another `exclusive()` callback, and don't add it inside `src/main/sync.ts` (the handlers already wrap those calls). Write handlers take the key _inside_ `exclusive()`, so a queued operation fails with `LOCKED` rather than using a stale key. `state.ts` and `config.ts` serialize their own read-modify-write with separate `createSerial()` queues.
- Argon2id key derivation runs in a worker (`kdf.ts` + `kdf.worker.ts`, imported via electron-vite's `?modulePath`) so the main thread doesn't freeze.

### Push/pull flow (`src/main/sync.ts`)

- **Two steps.** `previewPush`/`previewPull` return a key-name diff plus `expected: {localHash, vaultHash}`. The commit (`push`/`pull`) re-reads both sides and refuses with `LOCAL_CHANGED`/`VAULT_CHANGED` if the hashes differ from what the user reviewed. Pushing over a vault copy that changed elsewhere also needs `overwriteConfirmed`.
- **Plaintext handling.** `withSnapshot` reads the local file and the decrypted vault payload, and zero-fills the plaintext buffers afterwards.
- **Status** comes from `core/status.ts`: local vs vault vs this machine's last sync. The last sync is stored per vault in `state.json` via `src/main/state.ts`.
- **The vault.** Everything outside `src/main/vault.ts` reaches the vault through a `Vault` object (`state`, `create`, `open`, `setupCodeState`, `showSetupCode`, `snapshot`, `write`):
  - `vaultFor(location)` gives the vault at a `VaultLocation` (`{ kind: 'folder', path }` or `{ kind: 'git', url, branch }`, `Settings.vault`);
  - `vaultAt(path)` gives the vault in a folder;
  - `vaultOn(store, secrets?)` gives the vault in any store (with this machine's secrets by default);
  - `configuredVault()` returns the one chosen in Settings, or null;
  - `requireVault()` is the same but throws `NOT_CONFIGURED`.

  `sync.ts`'s `Configured` replaces the location with the `Vault`, so sync can't reach the vault by path or URL. `config.ts` loads an old `vaultPath` as a folder location and saves only the new shape. Switching vaults goes through `saveVault()` in `handlers.ts` (inside `exclusive()`), which locks first.

- **Setup codes (vault format 2).** A vault created with a setup code (always, in a git repository) has a 128-bit secret that is never written to the vault. Its key is `vaultKey(argon2idOutput, secret, vaultId)` (HKDF-SHA256, `core/crypto.ts`); `meta.json` adds `secretId`, a public fingerprint (`secretIdOf`, `secretMatches`), so a wrong code (`SETUP_CODE_WRONG`) is told apart from a wrong password. Format 1 vaults (password only) are unchanged.
  - **Per machine:** `src/main/secrets.ts` keeps secrets by vault id in `<userData>/vault-secrets.json`, sealed with Electron `safeStorage`, mode `0600`. `vault.ts` takes a `VaultSecrets` (`vaultOn(store, secrets)`; `MemorySecrets` in tests). A missing or unreadable entry means the code is asked for again; no secure storage gives `SECRET_STORE_UNAVAILABLE`.
  - **Create** saves the secret before writing `meta.json` (and forgets it if that fails), and returns the code once. **Open** uses this machine's secret or a typed code (`parseSetupCode`, `core/setupcode.ts`), saved only after the key check passes. `SETUP_CODE_REQUIRED` means this machine needs it. `AppState.setupCode` is `'not-used' | 'saved' | 'needed'`; `vault:showSetupCode` returns it again while unlocked and only with the password.
  - **Tampering fails closed:** editing `meta.json` back to format 1 derives a different key (`WRONG_PASSWORD`); editing `secretId` makes the code not match.

- **Snapshots and compare-and-swap.** Reads go through `vault.snapshot()`, whose `read(key, id)` returns the payload with its storage `version`. Take one snapshot per operation: `listRepos` uses one for every row, and `withSnapshot` (`Snapshot.vaultVersion`) one per push or pull. `vault.write(id, bytes, expected)` writes only if the entry is still at that version (`null`: there is none), and otherwise throws `VAULT_CHANGED`; `saveEdit` rewords it with the editor's message. This is on top of the content-level `expected` the user reviewed, which stays.

- **Stores.** `vault.ts` holds all the policy: meta.json, the KDF and key check, entry names, decryption, vault states. Underneath it, a `VaultStore` (`src/main/store/types.ts`) only moves opaque bytes by name.
  - **The contract:**
    - names are one lowercase segment (`STORE_NAME_RE`), and anything else is rejected;
    - `snapshot()` is a read view: `names` hides the store's own internals, and `get` returns `{ bytes, version }`, or null for a missing object. Versions are opaque strings;
    - `write(name, bytes, expected)` is a compare-and-swap: it writes only if the object is still at `expected` (`null`: there is none), otherwise `StoreConflictError`. It replaces atomically, returns the new version, and of racing writes with the same `expected` exactly one wins. `meta.json` is written with `expected: null`, which keeps it exclusive;
    - `check()` runs before create and open, and throws an `AppError` if the store mustn't be used now;
    - `reachable` never throws;
    - `cleanUp` runs after unlock.
  - **The implementations:**
    - `FolderStore` (`store/folder.ts`): best-effort, as a folder allows. A snapshot lists the folder now and reads each file when asked; the version is the sha256 of the bytes. Writes are queued (`createSerial`), re-read the file and compare its hash, then `atomicWrite`: exact within this process, as good as Drive allows between machines. It removes its stale `.<name>.<hex>.tmp` files, and `names` drops anything that isn't a valid name, such as Drive conflict copies;
    - `GitStore` (`store/git.ts`): see Git vaults below;
    - `MemoryStore` (`store/memory.ts`): the reference implementation, for tests, with exact snapshots. Settings never selects it.
  - **`storeFor(location)`** (`store/index.ts`) returns one store instance per location, so a store can queue its own writes and a git store can reuse what it fetched. `vaultFor` uses it; `discardStore` forgets a refused repository's store and deletes its mirror.
  - **New stores** (S3-compatible, say) must pass `tests/store.test.ts`.
  - **Messages by kind.** `vault.ts` words unreachable, meta-missing and exists errors by `store.kind` (folder or repository); an unreachable git vault gives `GIT_VAULT_UNREACHABLE` with git's own reason.

- **Git vaults** (`src/main/store/git.ts`, `gitprivacy.ts`, `src/main/gitvault.ts`, `src/main/gh.ts`, `src/core/gitremote.ts`).
  - **The mirror:** a bare repo in `<userData>/git-vaults/<16 hex of sha256(url, branch)>.git` (`git init --bare --template=`), `origin` = the URL. Never a working tree. `refs/remotes/origin/<branch>` tracks the last head fetched or pushed, which keeps its objects from gc.
  - **Snapshot:** `ls-remote` (reused for `cacheMs`, 10 s; single-flight; a generation counter stops an older listing from replacing a head we pushed or fetched), then `fetch` only if that commit is missing. One commit per snapshot. `names` are the top-level regular files (mode 100644/100755) with valid store names; versions are blob ids. README, directories and links are ignored.
  - **Write:** inside the store's own queue (also used by fetch, update-ref, gc, init): check `expected` against the head's tree, `hash-object`, `mktree -z` from the head's raw `ls-tree -z` records (other entries byte for byte), `commit-tree` as `EnvVault <envvault@users.noreply.invalid>`, then `push --porcelain --force-with-lease=refs/heads/<b>:<head>` (empty for a new branch). Up to 3 attempts: a `[rejected]` push fetches and rebuilds on the new head; `[remote rejected]` is a `GIT_ERROR`. After a push, the tracking ref and the cached head are updated, so the next snapshot sees it.
  - **Hardening** (`hardening()`, `vaultEnv()`): `--git-dir` explicitly, `core.fsmonitor=false`, `core.hooksPath=<mirror>/no-hooks`, `protocol.allow=never` with only `https` and `ssh` allowed, `fetch.fsckObjects` and `transfer.fsckObjects`, `push.gpgSign=false`, `commit-tree --no-gpg-sign`, `push --no-verify`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, inherited `GIT_DIR`-style variables removed, and `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` only when neither `GIT_SSH`/`GIT_SSH_COMMAND` nor `core.sshCommand` is set. Timeouts: 10 s for `ls-remote`, 30 s otherwise; output is capped (`runProcess` in `src/main/exec.ts`).
  - **`check()`** (before create and unlock): the branch exists or the repository is empty (`GIT_VAULT_BRANCH_MISSING`), then the privacy check.
  - **Privacy check** (`checkPrivate` in `store/gitprivacy.ts`): `git ls-remote` of the `httpsFormOf` URL with `anonymousEnv()` (an environment built from scratch: `PATH`, proxies and Windows essentials only; empty `HOME` and `GIT_CONFIG_GLOBAL`; `GIT_CONFIG_NOSYSTEM`; `GIT_CEILING_DIRECTORIES`), `ANONYMOUS_ARGS` (`credential.helper=`, `core.askPass=`, https only), cwd an empty temp folder. `classifyAnonymous`: exit 0 is public (`GIT_VAULT_PUBLIC`); only a server asking for credentials (401/403, "could not read Username", "Authentication failed") is private; anything else, a 404 included, is `GIT_VAULT_UNVERIFIED`. No override. Needs git 2.32 (`requireGitVersion`, `GIT_TOO_OLD`).
  - **Choosing one** (`prepareGitVault`, outside `exclusive()`; the save inside it): `parseGitRemote`, git version, `defaultBranch()` (`ls-remote --symref` with your credentials, `main` for an empty repo), `checkPrivate`, then `holdsOtherFiles` refuses anything but vault files and README/LICENSE/`.gitignore`/`.gitattributes` (`GIT_VAULT_NOT_EMPTY`, mirror discarded).
  - **Channels:** `settings:setGitVault { url }`; `git:ghStatus`, `git:listRepos`, `git:createRepo { name }` (then the same checks and save), `git:openNewRepoPage` (opens `NEW_REPO_PAGE`, a fixed URL). `gh.ts` finds `gh` like git, passes fixed arguments and a name matching `REPO_NAME_RE` (never an option), parses its JSON with zod and never logs it; each function takes an injectable `GhRunner`.
  - **Tests only:** `GitStore`'s `allowLocal` allows local paths and `file://` and skips the privacy check; `cacheMs: 0` turns off listing reuse; `checkPrivacy` replaces the privacy check. Settings never sets them.

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
- **Mini mode** (`src/main/mini.ts`, `MiniView.vue`, setting `miniOnTop`, default on).
  - `window:setLayout` (`Layout` in `src/shared/types.ts`) switches between `full` and `mini` on one repo, `reviewing` while SyncDialog is open. Main owns the sizes; the renderer never sends numbers. `placeWithin` (`src/core/layout.ts`) keeps the window on its display.
  - Entering it saves the full window's normal bounds (and maximized/full screen state) and restores them on `full`. It works while locked: a compact unlock form replaces the lock screen, and a machine that needs the setup code goes back to the full window.
  - Main rechecks the repo's row (`listRepos(key, id, only)`) when its `.env` changes (`fs.watch` on the repo folder, debounced), on window focus and every 60 s, through `session.withKey`, and sends it as `EV.repoStatus`. Like `EV.autoPulled`, the renderer patches it in without calling IPC.
  - Pushes and pulls still go through `SyncDialog`, never a one-click path.
- **Pull safety.** Pulls require `.env` and `.env.bak.*` to be git-ignored and `.env` to be untracked. The backup is written from the bytes already read, and the temp file is named `.env.bak.tmp-<hex>` so the same ignore rule covers it. Writes are atomic via `src/main/fsutil.ts`.

### Invariants to preserve

- Env **values** never get logged, and cross IPC only through:
  - `repo:pullRawDiff` with `values: true` (the user's **Show values** click). The renderer keeps them only in `SyncDialog`'s local `rawValues` ref (never the store) and shows them only in `RawDiffView.vue`, which hides them again;
  - `repo:openEditor` (main → renderer) and `repo:saveEdit` (renderer → main, changed values only). The renderer keeps them only in `EnvEditorDialog.vue`'s local `rows`, masked until shown and re-masked when the window is hidden or the editor is idle.

  Every other channel, and the envvault socket, carries only key names, statuses, hashes and metadata. Error messages from the editor flows never contain keys or values (`EditError` messages are fixed strings). `console.error` is the only allowed console call (lint enforces it). When logging a caught error, log only `err.name`, never the error object or its message (V8's `JSON.parse` errors quote their input).

- The **setup code** is a credential (with the password it opens a copy of the vault). It crosses IPC only in the `session:createVault` reply, `session:unlock` requests and the `vault:showSetupCode` reply. It's never logged, never in `store` or an error message, and the renderer keeps it only in component-local refs (`LockScreen.vue`, `SetupCodeField.vue`), cleared once used, on lock (`lockEpoch`), and when hidden. The vault's secret never leaves main except as that code, and stores never see it (lint bans `secrets` and `core/setupcode` there). The app still grants no clipboard permission: the code is shown with `user-select: all` for copying by hand.
- Background work must never make the renderer call IPC: every request resets the idle auto-lock (`ipcHooks.onAuthorizedCall`), so it would keep the vault unlocked. That's why `EV.autoPulled`, `EV.cliPushed` and `EV.repoStatus` carry the updated rows and the renderer patches `store.repos` instead of refetching. Main-side background work uses `session.withKey`, which doesn't touch the timer.
- Requests from the envvault socket never reset the idle timer either: they don't go through `ipcHooks`, so a script or Claude polling `status` can't keep the vault unlocked. Don't add a `touch()` there.
- A store (`src/main/store/`) only ever sees encrypted entries and the plaintext `meta.json`, never a key or a value. ESLint stops store modules from importing `session`, `kdf`, `sync`, `vault`, `localkeys`, `secrets` and the crypto, setup-code, env-diff and editor modules of `core`.
- The renderer never supplies file paths. Folders come from the native picker in main; repos are referenced by validated name (`isValidRepoName`), and paths are resolved with `resolveInside`/`isInside` (`src/core/paths.ts`). A git vault's URL is the one location the renderer sends (`setGitVault`, or a listed repo's URL round-tripping), and main parses it with `parseGitRemote` before git sees it: `https://`, `ssh://` or `user@host:path` only, no credentials, local paths, `file://`, other transports, whitespace or leading `-`. Its error messages never quote the URL. `GitStore` parses it again, so a hand-edited `config.json` can't reach git either.
- `meta.json` in the vault is attacker-controlled. Read it only through `parseMeta` (`src/core/crypto.ts`), which bounds the KDF params to `KDF_DEFAULTS`..`KDF_MAX`; the key check is bound to the `vaultId`.
- Run git only through `git()`/`runGit()` in `src/main/git.ts` (gh through `runGh` in `gh.ts`). Executables come from `findExecutable` (`src/main/exec.ts`), which uses absolute PATH entries only, so a repo can't supply its own `git.exe`. `git()` passes `-c core.fsmonitor=false`; git vault commands add the hardening above, and the privacy check its anonymous environment. Keep both lists intact.
- A git vault's commits carry no machine name or user identity, only `EnvVault`; `updatedBy` stays inside the ciphertext.
- The CSP is injected as a `<meta>` tag by a plugin in `electron.vite.config.ts` (strict in production, relaxed only for Vite dev). Don't add a second CSP header. Production `style-src 'self'` also blocks `style="..."` attributes, so put styles in `src/renderer/src/assets/main.css` (`:style` bindings are fine).

## Scope

Setup codes don't yet cover: upgrading a format 1 vault (re-key every entry, and old copies stay in history), changing the password or the secret, pairing a new machine through the vault or the Bitwarden CLI, or clearing the clipboard.

Git vaults don't yet cover: S3-compatible stores, choosing a branch, pruning history, `cat-file --batch` for many repos, or unlocking without network (`check()` needs the remote).

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

- `tests/{cliendpoint,crypto,envdiff,envedit,example,gitremote,layout,linediff,localkeys,paths,setupcode,status}.test.ts` unit-test `src/core/`. `crypto.test.ts` and `setupcode.test.ts` pin format 2's HKDF outputs and a setup code's encoding with vectors checked against independent implementations. `gitremote.test.ts` covers URL parsing (accepted and refused forms), branch names, the https mapping and `classifyAnonymous` against real git stderr. Most crypto tests use small Argon2 params; two deliberately use the real `KDF_DEFAULTS` and `KDF_MAX` (a few seconds) to prove the WASM build can allocate them.
- `tests/sync.test.ts` is an integration test of the main-process flows with real temp folders, real `git` and real crypto:
  - It mocks only `electron` (`app.getPath` returns a per-machine `userData`), `../src/main/kdf` (fast KDF params) and `../src/main/store/git` (`GitStore` with `allowLocal` and `cacheMs: 0`).
  - Two machines are simulated by `vi.resetModules()` and re-importing the main modules with a different `userData` (`machine(name, { projects, vault })` for a git vault).
  - `describe('git vault')` runs push → pull → edit → automatic pull between two machines over a local bare repository.
  - The symlink test is skipped on Windows.
- `tests/store.test.ts` is the `VaultStore` contract, run with `describe.each` over every store (folder in a temp dir, memory, git over a local bare repo): creating with `expected: null`, writes at the current and at a stale version, racing writes, versions read back, names, copied bytes. Then folder-only behaviour (temp files, conflict copies, a file changed outside the store) and git-only behaviour: two machines (conflict on one file, rebuild on another), a branch reset backwards (the lease), its own write seen through the cache, parallel snapshots, README/directories/links kept, commit identity, global hooks not run in the mirror, the privacy hook, invalid URLs, unreachable remotes. `tests/vault.test.ts` runs the vault policy on a `MemoryStore`: states, `check()` stopping create and open before the key is derived, create races, open failures, tampered and swapped entries, a write against a stale snapshot.
- `tests/session.test.ts` runs the idle auto-lock with fake timers (on, off, changed while unlocked). `tests/config.test.ts` also covers `autoLock`'s default.
- `tests/secrets.test.ts` runs `secrets.ts` with `safeStorage` mocked by a reversible stand-in (save, load, forget, sealed on disk, mode `0600`, unreadable files, no secure storage). `tests/vault.test.ts` covers format 2 with a `MemorySecrets` per machine: codes required, wrong, invalid, saved only after the right password, shown again, tampering, and no secret kept for a vault that wasn't created. `sync.test.ts` mocks `safeStorage` the same way, and its git vault run moves the code from machine A to B.
- `tests/gitprivacy.test.ts` checks the anonymous environment shows no git config and drops askpass and config variables. `tests/gitvault.test.ts` covers `holdsOtherFiles` and URL refusals before git runs. `tests/gh.test.ts` runs `gh.ts` against a fake `GhRunner` (status, list parsing and order, create arguments and a taken name); the real `gh` is exercised by hand. `tests/config.test.ts` covers the `vaultPath` migration.
- `tests/cli.test.ts` runs the envvault command (`src/cli/main.ts`) against the real socket server with a fake command table, in a short `/tmp` folder because Unix socket paths are limited to about 104 bytes. `tests/skill.test.ts` covers the skill text and installing it into a temp folder.
