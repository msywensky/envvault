---
name: check
description: Run lint, typecheck and tests with a compact summary. Use after changing code, before saying work is done.
argument-hint: '[--no-test] [vitest file or -t filter]'
allowed-tools: Bash(npm run check:*), Bash(npx vitest:*)
---

Run `npm run check`. If arguments were given (`$ARGUMENTS`), pass them after `--`:
`npm run check -- <arguments>`.

Report the summary lines. For each failure, give the command, the first useful error and the file
to inspect. Do not paste passing output.

To iterate on one failing test file, `npx vitest run <file>` first, then `npm run check` again
before reporting success.
