// The Claude Code skill EnvVault can install (src/main/skill.ts writes it).
// It drives the envvault command, which only ever reports key names, so
// Claude never needs to see a value. Only the read-only commands are
// pre-approved: the real push still goes through Claude Code's own
// permission prompt.

/** Marks a SKILL.md as EnvVault's, so Settings may replace or remove it. */
export const SKILL_MARKER =
  '<!-- Managed by EnvVault: update or remove it from EnvVault Settings. Edits here are replaced. -->'

/** SKILL.md for `command`, the shell command that runs the CLI (e.g. `node "/path/envvault.mjs"`). */
export function skillMarkdown(command: string): string {
  return `---
name: envvault
description: Check whether a repo's .env files are in sync with the EnvVault vault, or push one to the vault. Use when the user asks to push, sync or check a .env with EnvVault.
allowed-tools:
  - Bash(${command} status *)
  - Bash(${command} push --dry-run *)
---

${SKILL_MARKER}

# EnvVault

EnvVault syncs \`.env\` files between the user's machines through an encrypted vault: each repo's root \`.env\`, and in a monorepo the \`.env\` in each package's folder. The \`envvault\` command below talks to the EnvVault app, which must be running and unlocked, with command-line access turned on in its Settings. The command reports key names only, never values.

**Never read, print, search, copy or edit \`.env\` or \`.env.bak.*\` files, and never put an env value in a command.** Nothing here needs the values.

Run each command from inside the repo, always with \`--json\`. The output is \`{"ok": true, "data": ...}\` or \`{"ok": false, "error": {"code": ..., "message": ...}}\`.

\`push\` uses the \`.env\` in the current folder or the nearest one above it in the repo, or else the repo's root \`.env\`. In a monorepo, run it from the package's folder. Instead of the current folder, \`--repo <name>\` names a repo in the user's projects folder, and with \`push\`, \`--path <path>\` names a \`.env\` in one of its folders (for example \`--path apps/web/.env\`).

## Check the status

\`${command} status --json\`, or \`${command} status --all --json\` for every repo. \`data\` is a list of rows, one per \`.env\` file, with \`name\` (the repo), \`path\` (the file in it: \`.env\` for the repo's root), \`status\` and \`vault\` (\`version\`, \`updatedBy\`, \`updatedAt\`):

- \`in-sync\`: nothing to do.
- \`local-newer\`: the local .env changed since the last sync. Push it.
- \`local-only\`: the vault has no copy yet. Push it.
- \`vault-newer\`: another machine pushed. EnvVault pulls it automatically (if that's turned on), or the user pulls it in the app.
- \`conflict\`: both sides changed. The user resolves it in the app.
- \`vault-only\` or \`no-env\`: there is no local .env (for \`vault-only\`, its folder may not be in this copy of the repo).
- \`error\`: see the row's \`error.message\`.

## Push

1. Run \`${command} push --dry-run --json\`. \`data.repo\` and \`data.path\` say which file it is, and \`data.preview\` has:
   - \`diff.added\`, \`diff.removed\`, \`diff.changed\`: the key names that change in the vault copy;
   - \`kept\`: machine-specific keys, whose values stay on this machine;
   - \`unmarked\`: keys the vault treats as machine-specific but this .env doesn't mark, so **their values would be uploaded**. Point these out;
   - \`example\`: warnings from comparing with \`.env.example\` (\`missing\`, \`undocumented\`, \`sameValue\`);
   - \`needsOverwrite\`: if true, the vault copy changed on another machine. Don't push; tell the user to resolve it in EnvVault;
   - \`sameContent\`: if true, there is nothing to push.

   \`data.expect\` is the token for step 3.
2. Show the user the repo name, the file's path, the key changes and any warnings, and ask whether to push. Never push without a yes.
3. Run \`${command} push --expect <token> --json\` with the token from step 1, from the same folder (or with the same \`--repo\` and \`--path\`). If it fails with \`LOCAL_CHANGED\` or \`VAULT_CHANGED\`, something changed since step 1: start again from step 1.

## Errors

- \`LOCKED\` (exit code 3): ask the user to unlock EnvVault, then try again.
- \`CLI_UNAVAILABLE\` (exit code 4): EnvVault isn't running, or command-line access is off in its Settings. Ask the user.
- \`OVERWRITE_NOT_CONFIRMED\`: the vault copy changed on another machine. The user resolves it in EnvVault.
- \`REPO_NOT_FOUND\`: this folder isn't inside a repo in the user's projects folder. Ask which repo, and pass \`--repo <name>\`.
- Anything else: tell the user \`error.message\`.
`
}
