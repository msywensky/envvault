# Core modules (`src/core`)

Pure logic only: no Electron, `fs` or `child_process` (`node:crypto` and `node:path` are allowed); must not import main or renderer. Unit-tested in `tests/`.

- `crypto.ts` — vault format 2: `vaultKey(argon2idOutput, secret, vaultId)` (HKDF-SHA256); `fileTagger` is HMAC-SHA256 of `<repoId>/<pathId>` under an HKDF key, first 8 bytes hex; `sealBase`/`openBase` use an HKDF subkey (`envvault:base:v1`) whose AAD binds vault id, state id, version and hash. `parseMeta` bounds KDF params to `KDF_DEFAULTS`..`KDF_MAX` and binds the key check to the `vaultId`. Root entries use the strict `PayloadSchema`; file entries `FilePayloadSchema` (root plus `path`) with AAD `envvault:file:v1:<repoId>/<tag>`; `settings.enc` uses `envvault:settings:v1`. `encryptPayload` writes exactly its fields.
- `envpath.ts` — `isEnvFileName` (the names discovery finds: `.env`, `.env.<suffix>`, not reserved); `isSyncFileName` (those, or any other safe name for a file picked by hand: no `.git*`, templates, trailing dot or device names); `isEnvPath` (a `isSyncFileName` in at most 8 ASCII folders; no `.`, `..`, `.git`); `backupName` (`.env.bak.<stamp>`, `.env.bak.local.<stamp>`, `.env.bak.@<name>.<stamp>` for other names; `@` never appears in a `.env.<suffix>`, so they never collide).
- `envdiff.ts` — `parseEnv`/`scanEnv`, `maskEnvLines`, `diffKeys`, and `isDotenvText` (every line blank, a comment or part of an assignment: the format check for picked files with other names).
- `envlines.ts` / `localkeys.ts` — line scanner; a `# envvault:local` line marks the next assignment.
- `envedit.ts` — `decodeValue`/`encodeValue` follow dotenv 16 exactly; `applyEdits` splices so untouched lines stay byte for byte.
- `envmerge.ts` — `compareEnv` (three-way `here`/`there`/`suggested`; two-way `differs`/`local-only`/`vault-only`, machine-specific keys omitted), `layoutChanged`, `mergePull`/`keepLocal`/`mergeKeys`. Flow details are in `src/main/CLAUDE.md`.
- `status.ts` — hash-only `computeStatus`; refinements live in main and the renderer.
- `vaultsettings.ts` — settings schema `{ format: 1, updatedBy, updatedAt, defaults, repos }`, `z.looseObject` so unknown fields survive, `format > 1` → `VAULT_NEEDS_UPDATE`, inheritance via `effectiveRules`, `BUILT_IN_RULES` is `.env` only. A repo's `files` (picked by hand) are checked when read (`repoRules` drops paths `isEnvPath` refuses, copies, and any past `MAX_PICKED_FILES`), not by the schema, so a newer version's paths never make the document unreadable. Patterns live in `src/shared/envrules.ts`.
- `password.ts` — new vaults: 12+ characters, zxcvbn-ts score 3, machine/folder/repo names as context, first 128 characters only.
- `paths.ts` — `resolveInside`/`isInside`.
- `example.ts` — advisory `.env.example` key comparison.
- `gitremote.ts` — `parseGitRemote` (https/ssh/scp-like only), `httpsFormOf`, `classifyAnonymous`.
- `setupcode.ts` — `parseSetupCode`. Also here: `cliendpoint.ts`, `layout.ts`, `linediff.ts`, `envdiff.ts`, `skill.ts`.
