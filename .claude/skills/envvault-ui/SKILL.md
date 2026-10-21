---
name: envvault-ui
description: Rules for changing EnvVault's Vue 3 renderer (components, the store, Settings tabs, styles). Use when editing anything under src/renderer.
paths: src/renderer/**
---

Before changing the renderer, read the root `CLAUDE.md` sections **Architecture** (renderer and
IPC bullets) and **Invariants to preserve**. The rules that most often bite:

- No Node or Electron imports and nothing from core/main/preload (ESLint enforces it). The only
  way out is `window.envvault`, through `call(() => …)` or `run(() => …)` in
  `src/renderer/src/store.ts`: pass a function, plain objects (copy fields out of reactive state;
  a proxy throws "An object could not be cloned"), and capture narrowed values before the arrow.
- No `v-html` (lint bans it).
- Production CSP `style-src 'self'` also blocks `style="..."` attributes: put styles in
  `src/renderer/src/assets/main.css`. `:style` bindings are fine.
- Settings has three tabs (`SettingsGeneral`, `SettingsSync`, `SettingsCommandLine`), all mounted
  with `v-show`, each saving on its own through `saveSettings(changes)` in `store.ts`. Never send
  a whole form's draft; `store.settingsTab` picks the tab from elsewhere.
- Env values live only in the component-local refs the invariants list (`SyncDialog` raw diff,
  `ResolveDialog`, `EnvEditorDialog`), never in the store, and are hidden again as described
  there. The setup code likewise stays in `LockScreen.vue`/`SetupCodeField.vue` refs.
- Background work never calls IPC (it would keep the vault unlocked): events like
  `EV.autoPulled`, `EV.cliPushed` and `EV.repoStatus` carry rows to patch `store.repos` with.

cymbal doesn't index `.vue`: use Grep/Read for components. Check visible changes in the running app
(the `envvault-debug` skill), not only with tests, then run `npm run check`.
