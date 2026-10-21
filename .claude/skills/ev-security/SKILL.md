---
name: ev-security
description: Security-only review of the current EnvVault branch against its PR base, using the repo's invariants and docs/security.md.
disable-model-invocation: true
allowed-tools: Bash(node scripts/review-scope.mjs:*), Bash(git diff:*), Bash(git show:*), Bash(cymbal changed:*), Read, Grep, Glob, Agent
---

Security review of the current branch. Do not edit anything.

1. Run `node scripts/review-scope.mjs` for the base and the classified file list. If it fails, stop
   and report why. If the scope is docs only, say so; review a changed `docs/security.md` against
   the code anyway.
2. If cymbal is on PATH, run the `cymbal changed --base <sha> --no-federate` line it printed. If
   not, continue without symbol data and say so.
3. Launch only the `security-reviewer` agent with the base sha, the file list and the symbols.
4. Report its findings, blockers first, each with `file:line`, then a two-line summary.

For a generic pass alongside this, the built-in `/security-review` and `/code-review` still exist;
this skill adds the repository's own invariants.
