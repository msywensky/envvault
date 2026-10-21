# Tests

`npm test` runs `tests/**/*.test.ts` (Vitest). Unit tests cover `src/core/` plus `src/shared/envrules.ts`; integration tests use real temp folders, real `git` and real crypto.

## Layout

- Core unit tests: `tests/{cliendpoint,crypto,envdiff,envedit,envmerge,envpath,example,gitremote,layout,linediff,localkeys,password,paths,setupcode,status,vaultsettings}.test.ts`; `tests/envrules.test.ts` covers the patterns.
- `tests/sync.test.ts` — main-process flows between simulated machines. Describes cover the git vault, monorepo, repo settings, conflict resolution, machine-specific marks, pull-and-mark, and three-way merges.
- `tests/store.test.ts` — the `VaultStore` contract, `describe.each` over folder, memory and git stores, then store-specific behaviour.
- `tests/vault.test.ts` — vault policy on a `MemoryStore`: states, create/open, tampering, entries, settings.
- `tests/vaultfixture.test.ts` — opens `tests/fixtures/vault-format2` and writes on top. **Never regenerate the fixture**: a failure means existing vaults broke. `.enc` files are binary in `.gitattributes`; Prettier skips `tests/fixtures`.
- Others: `session`/`config` (auto-lock and defaults), `bases`, `secrets` (mocked `safeStorage`), `gitprivacy`, `gitvault`, `gh` (fake `GhRunner`), `cli` (real socket), `skill`, `claude-hook` (runs `scripts/claude-hook.mjs` and `scripts/verify.mjs`, the Claude Code hooks and `npm run check`).

## Caveats

- `sync.test.ts` mocks only `electron`, `../src/main/kdf` (fast params) and `../src/main/store/git` (`allowLocal`, `cacheMs: 0`). Two machines are made with `vi.resetModules()` and a different `userData`.
- The discovery cache is per module instance: a fresh `machine()` needs `rows(m, true)` before relying on what git found.
- `tests/cli.test.ts` needs a short `/tmp` folder because Unix socket paths are limited to about 104 bytes.
- The symlink test is skipped on Windows.
- Most crypto tests use small Argon2 params; two use the real `KDF_DEFAULTS`/`KDF_MAX`.
