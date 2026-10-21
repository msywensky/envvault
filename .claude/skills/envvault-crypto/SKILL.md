---
name: envvault-crypto
description: Rules for changing EnvVault's crypto, vault format, setup codes or meta.json handling. Use before touching src/core/crypto.ts, setupcode.ts, src/main/vault.ts, kdf, secrets or the vault fixture.
---

Crypto and the vault format are the highest-risk area of this repository. Before changing
anything, read, in this order:

1. `docs/security.md`: **Cryptography**, **Vault format** and **Threat model**.
2. `src/core/CLAUDE.md`, the `crypto.ts` and `setupcode.ts` entries (format 2, `vaultKey`,
   `fileTagger`, the AAD strings, `sealBase`/`openBase`, `parseMeta` bounds).
3. `src/main/CLAUDE.md`, **Setup codes** and **The vault**.

Rules that must survive any change:

- `meta.json` is attacker-controlled: read it only through `parseMeta`, which bounds the KDF
  params to `KDF_DEFAULTS`..`KDF_MAX` and binds the key check to the `vaultId`.
- AAD strings (`envvault:file:v1:…`, `envvault:settings:v1`, `envvault:base:v1`) and HKDF labels
  are part of the format. Changing one breaks every existing vault.
- **Never regenerate `tests/fixtures/vault-format2`** (edits there are denied). If
  `tests/vaultfixture.test.ts` fails, existing vaults broke: fix the code, not the fixture.
- Key material: use `session.withKey(fn)` (a wiped copy); never hold the session key, log it, or
  pass it to a store. Plaintext buffers are zero-filled after use.
- The setup code and the vault secret never reach logs, the store, error messages or stores; the
  secret leaves main only as the code.
- Argon2id runs in the worker (`kdf.ts` + `kdf.worker.ts`), never on the main thread.

A change to the format or the threat model needs `docs/security.md` updated in the same change.
Review it with `/ev-security` before committing.
