---
name: navigate
description: Answer a code-navigation question about EnvVault with cymbal (where, who calls, what uses).
argument-hint: <question or symbol>
context: fork
agent: navigator
background: false
disable-model-invocation: true
---

Answer this code-navigation question about the repository in the current directory:

$ARGUMENTS

Use cymbal first (`investigate`, `trace`, `impact --no-tests`, `outline`, `show`, `search`) and
Grep/Read only for `.vue`, Markdown, JSON and YAML. Return `file:line` references and a short
explanation; do not paste whole files.
