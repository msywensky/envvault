---
name: ev-impact
description: Summarize the blast radius of changing an EnvVault symbol (callers, dependencies, affected flows), without editing.
argument-hint: <symbol>
context: fork
agent: navigator
background: false
disable-model-invocation: true
---

Summarize what changing `$ARGUMENTS` would affect in the repository in the current directory.

1. `cymbal investigate $ARGUMENTS` to confirm what it is and where it's defined.
2. `cymbal impact $ARGUMENTS --no-tests` for transitive production callers, then
   `cymbal impact $ARGUMENTS` for the tests that cover it.
3. `cymbal trace $ARGUMENTS` for what it depends on.
4. Grep `.vue` files for it too if it can reach the renderer (cymbal doesn't index `.vue`).

Report: definition (`file:line`), direct callers, the flows or channels they belong to, the tests
covering it, and anything security-relevant on the path (IPC, crypto, stores, git). Do not edit.
