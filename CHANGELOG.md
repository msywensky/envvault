# Changelog

## 0.1.0

First release. Unsigned installers for Windows and macOS.

- Sync each repo's `.env` between machines through an encrypted vault: a synced folder or a private git repository (including your own server, once you confirm it is private).
- XChaCha20-Poly1305 with an Argon2id key from the master password, plus a per-machine setup code (always for git vaults). Easily guessed master passwords are refused (zxcvbn-ts).
- The packaged app refuses remote debugging and has no DevTools.
- Review-first push and pull, conflict handling, machine-specific keys, `.env.example` checks, editing the vault copy, automatic pull (off by default), mini mode.
- A pull backs up the local `.env` first and keeps the newest 3 backups per repo (both adjustable in Settings).
- Optional `envvault` command (`status`, `push`) and a Claude Code skill.
