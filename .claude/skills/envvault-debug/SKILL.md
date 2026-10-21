---
name: envvault-debug
description: Inspect or drive the running EnvVault app (Electron) over the Chrome DevTools Protocol, with isolated dev profiles. Use when a change needs checking in the real app, a UI bug needs reproducing, or two machines must be simulated.
---

How to run and inspect the app. The details are in the root `CLAUDE.md` (Commands); this is the
procedure.

- **Isolated settings.** Never run against the user's real settings. Use a profile:
  `ENVVAULT_PROFILE=<name>` gives `<appData>/envvault-<name>`. Names must match `PROFILE_RE`
  (`src/shared/cli.ts`); `src/main/profile.ts` silently falls back to the real settings for any
  other name, so validate first. `npm run dev:profile -- <name> [--reset]` validates for you.
- **CDP.** Start with `ENVVAULT_PROFILE=<name> npx electron-vite dev --remoteDebuggingPort 9222`,
  or after `npm run build`, `ENVVAULT_PROFILE=<name> npx electron . --remote-debugging-port=9223`.
  Then drive `window.envvault` (the preload API) and the DOM over CDP at that port.
- **Two machines.** Two profiles pointed at the same vault folder stand in for two machines. Use a
  scratch vault folder, never a real one, and never select or fetch the user's existing GitHub
  repositories when testing git vaults.
- **CSP checks.** When testing that the CSP blocks `eval`, pass
  `allowUnsafeEvalBlockedByCSP: false` to `Runtime.evaluate` (it defaults to true).
- **Packaged app.** It refuses `--remote-debugging-port`/`--remote-debugging-pipe`, has DevTools
  off and ignores `ENVVAULT_PROFILE`, so CDP works only unpackaged.
- **Evidence.** Logs aren't proof of what the user sees (notifications, windows, focus). Check the
  DOM or a screenshot, and when an OS-level effect matters, ask the user what they saw.
- **Never** read `.env` files to check a result: compare key names, statuses and hashes the app
  reports, or ask the user to look.
