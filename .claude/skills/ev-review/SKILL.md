---
name: ev-review
description: Review the current EnvVault branch against its PR base with parallel security, IPC and sync reviewers.
disable-model-invocation: true
allowed-tools: Bash(node scripts/review-scope.mjs:*), Bash(git diff:*), Bash(git show:*), Bash(cymbal changed:*), Bash(cymbal impact:*), Bash(cymbal trace:*), Read, Grep, Glob, Agent
---

Review the current branch. Do not edit anything unless the user asks for fixes afterwards.

1. Run `node scripts/review-scope.mjs`. It prints the base (the PR's base branch, so a stacked PR is
   reviewed against its parent; it says when it fell back to `main`), every changed file including
   untracked ones with its class, and which reviewers to launch. If it fails, stop and report why.
2. If cymbal is on PATH, run the `cymbal changed --base <sha> --no-federate` line it printed and
   keep the symbol list. If not, continue from the file list and `git diff` alone, and say so in
   the summary.
3. If the scope says docs only, check the changed docs against the code they describe (names,
   flags, paths, behaviour) and stop.
4. Otherwise launch the reviewers it listed (`security-reviewer`, `ipc-reviewer`,
   `sync-reviewer`) **in parallel**, in one message. Give each one the base sha, the classified
   file list and the changed symbols.
5. Synthesize: blockers first, then warnings, then nits, each with `file:line`. Merge duplicates
   across reviewers. Say which reviewers ran and whether symbol data was available.
