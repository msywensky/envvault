# Security policy

EnvVault handles secrets, so please report vulnerabilities privately.

**Report one** through [GitHub's private vulnerability reporting](https://github.com/msywensky/envvault/security/advisories/new) (Security tab → Report a vulnerability). Please don't open a public issue or pull request for it. Include the version, your OS, and the steps to reproduce.

You can expect an acknowledgement within a week. EnvVault is a one-person project, so fixes are made as soon as I can, and I'll credit you in the release notes if you like.

**Supported versions:** only the latest release.

What EnvVault does and doesn't protect against is in [docs/security.md](docs/security.md); reports about things listed there as out of scope (malware running as you while it's unlocked, a weak password, plaintext `.env` files in your repos) are welcome as suggestions but aren't vulnerabilities.
