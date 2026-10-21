---
name: ev-channel
description: Add or change an EnvVault IPC channel (renderer ↔ main) in all five places, with its schema, handler and renderer call. Use whenever a new window.envvault function or IPC channel is needed.
argument-hint: <channel name and what it does>
---

Add or change the IPC channel: $ARGUMENTS

The rules are in the root `CLAUDE.md` (**IPC** and **Invariants to preserve**); read them first
instead of relying on this summary. Locate the current patterns with cymbal
(`cymbal investigate handle`, `cymbal search <similar channel>`), then make the change in all five
places, in this order:

1. `src/shared/channels.ts`: the `CH` entry (`area:verb`).
2. `src/shared/api.ts`: the `Responses` entry and the `EnvVaultApi` method.
3. `src/main/schemas.ts`: the `[CH.x]` entry in `requestSchemas`, `z.strictObject({...})` or
   `NoArgs`. Repo names, env paths and patterns use the existing validated types (`RepoName`,
   `EnvPath`, ...); the renderer never sends a file system path.
4. `src/main/handlers.ts`: `handle(CH.x, async (req) => ...)` (`handle` in `src/main/ipc.ts`
   looks the schema up and validates). **This is the step that still compiles when forgotten**
   (it fails at runtime as "Lost contact with the app"). Write
   handlers wrap the work in `exclusive()` and take the key inside it with `session.withKey`.
   Expected failures throw `AppError(code, message)` with a code from `src/shared/result.ts`, and
   messages never echo input.
5. `src/preload/index.ts`: the `api` function.

Renderer side (`src/renderer/src/store.ts` or the component): call it as
`call(() => window.envvault.x(...))` or `run(...)`, with plain objects (copy fields out of reactive
state first) and narrowed values captured before the arrow.

If the channel carries env values or the setup code, stop and ask: only the paths listed in the
root `CLAUDE.md` invariants may, and a new one needs a design and a `docs/security.md` update first.

Test the main-side behaviour the way the existing flows are tested (`tests/sync.test.ts` for sync
flows, `tests/vault.test.ts` for vault policy; see `tests/CLAUDE.md`), then run `npm run check`.
