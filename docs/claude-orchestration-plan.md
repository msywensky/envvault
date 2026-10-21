# Claude / opencode orchestration plan

Status: phases 0–4 implemented on `chore/llm-cleanup` (2026-10-21); phase 5 (optional CI review) not started. Section 17 records what differs from the text below.
Last verified: 2026-10-21
Tools: Claude Code, opencode, cymbal v0.17.0, Node 22, macOS (Windows must keep working)

## 0. Review notes (2026-10-21)

Changes from the first draft, each checked against the repo, cymbal v0.17.0 and the Claude Code docs:

1. **Phase 0 is out of date.** `~/.claude/settings.json` now has one cymbal pair, and neither entry has a `"marker"`. Following the old step 5.2 ("keep only marked entries") would delete both. The step now checks by command instead.
2. **cymbal's nudge auto-approves compound commands.** For every command it nudges on (repo-wide searches such as `grep -rn x src` or `rg x`; a scoped `grep -n x file.ts` gets no nudge), `cymbal hook nudge` returns `permissionDecision: "allow"`. That includes `grep -rn foo src && git push --force` and `rg foo; rm -rf out`. Deny and ask rules still apply, but anything they don't cover runs without a prompt. New step 5.3 wraps the nudge so it keeps the note and drops the decision.
3. **Diff classification was unsafe.** cymbal doesn't index `.vue`, so a renderer-only diff reports no changed symbols. The old rule then called it "docs/config-only" and skipped every code reviewer. Config isn't safe to skip either: the CSP plugin lives in `electron.vite.config.ts`, and the fuses and entitlements in `electron-builder.yml`. Classification now uses file paths (8.1).
4. **The review base was wrong for stacked PRs** (e.g. #29 on #28). It now uses the PR's `baseRefName` and fetches it first. `cymbal changed` and `git diff` now both cover the same range, working tree included.
5. **Name collisions.** A project skill named `security-review` replaces the built-in `/security-review`, and `review` is an alias of the bundled `/code-review`. The commands are renamed to `/ev-review` and `/ev-security`.
6. **Commands are skills now.** `.claude/commands/*.md` still works, but `.claude/skills/<name>/SKILL.md` adds `context: fork` + `agent:`. That runs a skill directly in a subagent, so `/check` no longer needs a wrapper prompt that says "run the verifier subagent". In `allowed-tools`, `Task` is now `Agent`.
7. **Windows spawning.** Since the CVE-2024-27980 fix, Node 22 refuses to `spawn('npm.cmd')` without `shell: true` (`EINVAL`). `verify.mjs` and the hook now run `node <npm_execpath>` or the package bin with `process.execPath`, never `npm.cmd`/`npx.cmd`.
8. **Hook output goes to stderr.** On exit 2, Claude sees only stderr; stdout goes to the debug log. Also, a single-file ESLint run takes about 2–3 s with `npx` and 1.5–2 s with the bin called directly, because the config uses `projectService` (type-aware).
9. **The Stop typecheck would fire on the user's own work.** `git status --porcelain` also sees edits Claude didn't make. A type error in the user's work-in-progress would then keep every turn from ending. The hook now typechecks only after this session edited code.
10. **`.env` reads go into `permissions.deny`.** Edit rules cover every file-editing tool. Read rules are applied to Grep and Glob on a best-effort basis. The guard hook is a best-effort Bash filter, not a boundary.
11. **Permission fixes:** `Bash(git status)` matched only the bare command, so it's now `git status:*`. `Bash(cymbal:*)` also allowed `cymbal hook install/uninstall` and `index`, so it's narrowed to read-only subcommands.
12. **Native worktrees.** `claude --worktree` and the Agent tool's `isolation: "worktree"` already exist. The helper script becomes a fallback and uses the same `.claude/worktrees/` location.
13. **The opencode guard was missing.** `.claude/settings.json` hooks don't run in opencode. Mirroring permissions alone leaves opencode with no `.env` or destructive-command guard (6.7).
14. **Reviewer checklists copied CLAUDE.md.** They now point at the root "Invariants to preserve" list and the area files, plus a few review-only checks, so the two can't drift apart.

Second review (section 16) — applied: R1–R11, R13–R16 (R3 as the broadened guard, R5 as a git-only fallback, R8 with build/format config in its own class). Rejected: R12, because the ESLint cache always misses right after an edit. Third review — applied: R17, R19–R21, and R22 as "editing subagents stay in the main checkout". Rejected: R18, because cymbal already skips nested worktrees (tested). Section 16 records each decision.

## 1. Goals

- Keep the always-loaded context small: root `CLAUDE.md` plus area files, no duplication.
- Make cymbal the navigation layer for TypeScript, without breaking Vue work.
- Give agents one verification entry point with compact output.
- Put guardrails around env values, the vault fixture, generated output and destructive git.
- Split review into focused, read-only subagents that can run in parallel.
- Support parallel implementation in worktrees without index or build collisions.
- Keep the setup reproducible and safe on both macOS and Windows.

## 2. Non-goals

- No new MCP servers for ordinary file or GitHub access; `gh` and native tools suffice.
- No CI dependency on cymbal.
- No auto-commit, auto-push or auto-merge by agents.
- No second always-loaded memory file; procedures belong in agents or skills.
- No changes to the security model or vault format as part of this plan.

## 3. Current state

What is already good:

- Root `CLAUDE.md` is split into `src/main`, `src/main/store`, `src/core` and `tests` area files (uncommitted on `chore/llm-cleanup`).
- ESLint enforces the import boundaries between core, main, preload, shared, renderer and cli.
- CI runs lint, tests and build on macOS and Windows.
- Husky runs ESLint with `--max-warnings 0` on staged files (`lint-staged` in `package.json`).
- Cymbal is installed at user scope for Claude Code and opencode (`~/.config/opencode/plugins/cymbal-opencode.js`).
- Cymbal has indexed the repo: 116 files, 2025 symbols (before the `out/` exclusion in 5.4; both counts drop after it).
- There is no project `.claude/` directory yet.
- Claude Code 2.1.306 (skills' `background` field needs 2.1.218 or later).

Measured locally:

- `npm run typecheck`: about 6.5 s.
- `npm test`: about 28 s, 725 passing, 1 skipped.
- ESLint on one file (type-aware, `projectService`): about 2–3 s via `npx`, 1.5–2 s calling `node_modules/eslint/bin/eslint.js` directly. A cache hit takes about 0.6 s, but only for an unchanged file.
- Cymbal indexes 106 TypeScript files, 7 JavaScript, 2 YAML, 1 Bash (before 5.4).
- Cymbal indexes 0 of the 25 `.vue` files.
- Cymbal currently indexes 5 files under `out/`.

Known issues to fix first:

1. ~~Duplicate cymbal hooks~~: resolved. One `PreToolUse` Bash nudge and one `SessionStart` reminder remain, both **without** a `"marker"` field.
2. The cymbal nudge returns `permissionDecision: "allow"` for every Bash command it nudges on (repo-wide `grep -r`/`rg`), including compound commands. Example: `rg foo; rm -rf out` is approved without a prompt unless a deny/ask rule matches.
3. The cymbal index includes `out/cli/envvault.mjs`, `out/main/index.js`, `out/main/chunks/kdf.worker-*.js`, `out/preload/index.js` and renderer build output. This pollutes `search`, `investigate` and `refs`.

## 4. Target architecture

```
cymbal index (OS cache, per worktree)
        |
        v
navigator / area reviewers        cymbal-first investigation (read-only subagents)
        |
        v
npm run check                     compact output, run directly; no subagent needed
        |
        v
main agent                        edits and synthesis
```

Navigation policy:

- Use cymbal for `src/core`, `src/main`, `src/preload`, `src/shared`, `src/cli`, `scripts` and `tests`.
- Use Grep/Glob/Read for `src/renderer/**/*.vue`, Markdown, JSON, YAML configuration and the vault fixture.
- Prefer `cymbal changed --base <merge-base> --no-federate` to scope a review to a branch (see 8.1 for the base).
- Use `cymbal investigate`, `trace` and `impact` before reading whole files.
- Use `cymbal outline` and `cymbal show file:Lx-Ly` for targeted reads.
- Use `cymbal search` before grep; `cymbal search --text` for literals or regexes.
- Batch symbols: `cymbal investigate A B C`.
- Use `--json` only in scripts; the default text output is cheaper for agents.

## 5. Phase 0: hygiene and cymbal baseline

Goal: one nudge, one reminder, no auto-approval from the nudge, a clean index.

### 5.1 Back up user settings

```sh
cp ~/.claude/settings.json ~/.claude/settings.json.bak-$(date +%Y%m%d-%H%M%S)
```

### 5.2 Check for duplicate cymbal hooks

Identify cymbal entries by their **command** (`cymbal hook nudge` / `cymbal hook remind`), not by `"marker"`; the current install writes no marker. Before 5.3 there should be exactly one of each:

```sh
grep -c 'cymbal hook nudge' ~/.claude/settings.json    # 1 now; 0 after 5.3
grep -c 'cymbal-nudge.mjs' ~/.claude/settings.json     # 0 now; 1 after 5.3
grep -c 'cymbal hook remind' ~/.claude/settings.json   # 1
```

If a reinstall adds a second copy, remove the extra entry by hand. Leave unrelated plugins and settings alone.

### 5.3 Stop the nudge from approving commands

The nudge is useful context, but its `"allow"` skips the permission prompt for the whole command line. Precedence between hooks is `deny` > `defer` > `ask` > `allow`, and deny/ask rules are still evaluated. So the risk is any command that no rule covers, chained after a `grep`: `find -delete`, `git checkout -- .`, `npm install <pkg>`, and so on.

Wrap it at user scope so only an `allow` is dropped. `additionalContext` passes through, and so does any future `deny` or `ask` from cymbal, with its reason. `~/.claude/hooks/cymbal-nudge.mjs`:

```js
import { spawnSync } from 'node:child_process'

const input = await new Promise((resolve) => {
  let s = ''
  process.stdin.on('data', (d) => (s += d)).on('end', () => resolve(s))
})
const r = spawnSync('cymbal', ['hook', 'nudge', '--format=claude-code'], {
  input,
  encoding: 'utf8'
})
try {
  const out = JSON.parse(r.stdout)?.hookSpecificOutput
  if (out) {
    if (out.permissionDecision === 'allow') {
      delete out.permissionDecision
      delete out.permissionDecisionReason
    }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: out }))
  }
} catch {
  // no nudge for this command
}
```

Register it in exec form with an absolute path (exec form runs no shell and doesn't expand `~`), replacing the raw `cymbal hook nudge` entry:

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "node",
      "args": ["/Users/mike/.claude/hooks/cymbal-nudge.mjs"],
      "timeout": 5
    }
  ]
}
```

Also open a cymbal issue asking for a flag that leaves out `permissionDecision`. Once one exists, drop the wrapper. `cymbal hook install` and upgrades can add the raw entry back. A raw entry's `allow` would then win over the wrapper's no-decision, so after every cymbal upgrade check that the only nudge entry is the wrapper (5.2 counts).

### 5.4 Clean up the index

```sh
cymbal index . --exclude 'out/**' --exclude 'dist/**'
cymbal ls --names | grep -E '^(out|dist)/'   # expect no output
cymbal investigate listRepos | head -20      # expect only src/main/sync.ts
```

`cymbal index --help` says filter flags on a full index persist for later incremental refreshes. Re-run the full index with the exclusions after a cymbal upgrade or an index-format change.

### 5.5 Verify opencode

- Cymbal plugin is installed at `~/.config/opencode/plugins/cymbal-opencode.js`.
- Keep it at user scope.
- The plugin soft-nudges Bash, Grep and Glob on non-Windows shells.
- On Windows the nudge does not fire for Grep/Glob, so the cymbal-first rule must also live in agent prompts and `CLAUDE.md`.
- The opencode plugin does not auto-approve. Its `tool.execute.before` calls `cymbal hook nudge --format=json` and prepends a notice to the command; it returns no permission decision. 5.3 doesn't apply there.

### Acceptance

- Exactly one cymbal `PreToolUse` Bash hook (the wrapper, not raw `cymbal hook nudge`) and one cymbal `SessionStart` hook remain.
- `echo '{"tool_name":"Bash","tool_input":{"command":"rg foo; rm -rf out"}}' | node ~/.claude/hooks/cymbal-nudge.mjs` prints no `permissionDecision`.
- `cymbal ls --names` contains no `out/` or `dist/` paths.
- `cymbal investigate listRepos` does not mention `out/main/index.js`.

## 6. Phase 1: verification and guardrails

Goal: one check command, fast lint feedback, protected paths.

### 6.1 Add a single verification command

Add `scripts/verify.mjs` and an npm script:

```json
{
  "scripts": {
    "check": "node scripts/verify.mjs"
  }
}
```

`verify.mjs` responsibilities:

- Run `lint` and `typecheck` **in parallel** (both read-only), then `test`. Report every failure from the first stage before stopping, so one run gives the agent everything to fix.
- Run each tool's bin directly with `spawn(process.execPath, [bin, ...args], { cwd })`, resolving the bins from the repo's `node_modules`. `npm_execpath` is usually unset in hooks, and this way `npm run check`, `node scripts/verify.mjs` and the hooks behave the same. The commands mirror the `package.json` scripts:
  - lint: `eslint/bin/eslint.js --cache --max-warnings 0 .`
  - typecheck (node): `typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false`
  - typecheck (web): `vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.web.json --composite false`
  - tests: `vitest/vitest.mjs run --reporter=json --outputFile=<os.tmpdir() file> [filters]`
- Export the typecheck runner so `claude-hook.mjs` reuses it instead of copying the arguments. Add a test that checks these arguments still match the `package.json` scripts, so the two can't drift.
- Never spawn `npm.cmd`/`npx.cmd` (Node 22 throws `EINVAL` on Windows without `shell: true`) and never use `shell: true`.
- Capture output and print only failures, the failing command, and a final summary.
- Read test counts and failing test names from the JSON report; don't parse the human reporter. On failure, print each failing test's name, file and first assertion message only.
- Accept `--no-test` for a faster pass and `-- <vitest filters>` to pass through a file or `-t` pattern.
- Exit non-zero if anything failed.

Suggested success output:

```
lint ok
typecheck ok
tests 725 passed / 1 skipped (28 s)
```

Use `npm run check` in `/check`, in reviewer prompts, and in documentation. CI can keep its existing separate steps; they already match this definition.

### 6.2 Project permissions

Create `.claude/settings.json` in the repo. Do not include cymbal hooks; they stay at user scope.

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test:*)",
      "Bash(npx vitest:*)",
      "Bash(npm run lint:*)",
      "Bash(npm run typecheck:*)",
      "Bash(npm run check:*)",
      "Bash(node scripts/verify.mjs:*)",
      "Bash(cymbal search:*)",
      "Bash(cymbal investigate:*)",
      "Bash(cymbal context:*)",
      "Bash(cymbal show:*)",
      "Bash(cymbal outline:*)",
      "Bash(cymbal trace:*)",
      "Bash(cymbal impact:*)",
      "Bash(cymbal impls:*)",
      "Bash(cymbal refs:*)",
      "Bash(cymbal importers:*)",
      "Bash(cymbal changed:*)",
      "Bash(cymbal diff:*)",
      "Bash(cymbal structure:*)",
      "Bash(cymbal ls:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(git merge-base:*)",
      "Bash(git fetch:*)",
      "Bash(gh pr view:*)",
      "Bash(gh pr checks:*)",
      "Bash(gh pr diff:*)"
    ],
    "ask": [
      "Bash(git commit:*)",
      "Bash(git push:*)",
      "Bash(gh pr create:*)",
      "Bash(gh pr merge:*)",
      "Bash(npm run dev:*)",
      "Bash(npm start:*)",
      "Bash(npm run build:*)",
      "Bash(npm install:*)",
      "Bash(cymbal hook:*)"
    ],
    "deny": [
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(/**/.env)",
      "Read(/**/.env.*)",
      "Edit(**/.env)",
      "Edit(**/.env.*)",
      "Edit(/**/.env)",
      "Edit(/**/.env.*)",
      "Edit(/tests/fixtures/**)",
      "Edit(package-lock.json)",
      "Edit(/package-lock.json)",
      "Edit(out/**)",
      "Edit(dist/**)",
      "Edit(.git/**)",
      "Edit(/out/**)",
      "Edit(/dist/**)",
      "Edit(/.git/**)",
      "Bash(git reset --hard:*)",
      "Bash(git clean:*)",
      "Bash(git push --force:*)",
      "Bash(git push -f:*)",
      "Bash(rm -rf:*)",
      "Bash(npm publish:*)"
    ]
  }
}
```

Notes:

- Edit rules cover every built-in file-editing tool (Write included; a `Write(...)` or `MultiEdit(...)` path rule is never consulted). Claude Code applies Read rules to Grep and Glob only on a **best-effort** basis. Neither covers Bash (`cat .env`), which is why the guard hook exists.
- Bare-filename patterns follow gitignore rules and match at any depth, so `Read(**/.env)` covers the root `.env` too (same as `Read(.env)`). Relative patterns resolve against the **current** directory, so after a `cd src` they no longer reach `../.env` or `../out`. Each rule therefore has a project-root twin with a leading `/` (`/**/.env` includes the root `.env`). The relative rules still cover directories outside the project that Claude works in. A bare filename such as `package-lock.json` matches at any depth **under the current directory** only, so it needs a twin too: without `Edit(/package-lock.json)`, a Write from `src/` overwrote the root lock file in testing.
- Check the `/` anchor once in a `claude --worktree` session: from `src/` inside the worktree, Read `../.env` and Edit `../out/x` must be refused. If `/` resolves to the starting checkout rather than the worktree there, the relative rules are what cover the worktree root. Note that in the decision record.
- The repo has no `.env.example` today (`.gitignore` allows one). If one is added, carve it out with a gitignore negation **after** the rules it narrows, in the same deny list. A `!` pattern resolves against the current directory and can't carve out of `/`-anchored rules, so for those, list the protected variants explicitly instead (`/**/.env.local`, `/**/.env.*.local`, `/**/.env.production`, ...). An allow rule can't override a deny.
- Deny rules match each subcommand, including ones inside `$(...)`, subshells and loops, so `rg foo; rm -rf out` is denied. They're still a seatbelt: `git push origin +main` or `git -C . reset --hard` slip past them. Don't treat them as a boundary. If you need one, use Claude Code's sandbox settings.
- `cymbal index` stays unlisted (it prompts). It writes to the OS cache, and a bad `--exclude` silently changes the index for later sessions.
- Keep personal overrides in `.claude/settings.local.json`.

### 6.3 Gitignore additions

Add:

```
.claude/settings.local.json
.claude/worktrees/
.cymbal/
```

`.cymbal/` is only needed when using `CYMBAL_DB` or the Docker flow; the default index lives in the OS cache.

### 6.4 Hook script

Add `scripts/claude-hook.mjs`. It must be plain Node, cross-platform, and read hook JSON from stdin. **All feedback goes to stderr**; on exit 2 Claude sees stderr only.

Two roots, because they differ once Claude enters a worktree:

- **Working root** = `input.cwd || process.cwd()`. `cwd` follows Claude into a worktree and after a `cd`. Find the tree's top with `git rev-parse --show-toplevel` from `cwd`. Normalize `tool_input.file_path` (absolute, or with `\` on Windows) against it, and run ESLint, git and typecheck there, using that tree's `node_modules`.
- **`CLAUDE_PROJECT_DIR`** stays at the checkout where the session started. Use it only to locate this script.

Session edit records live in `<os.tmpdir()>/envvault-claude/<session_id>-<agent_id or "main">.json`, both IDs sanitized to `[A-Za-z0-9_-]`. `agent_id` is present only inside subagents. Parallel subagents share `session_id`, so per-agent files keep them from overwriting each other's lists. Each record is `{ path, root }`, one JSON line appended per edit (`.jsonl`). Appends of small writes are atomic, so parallel edits by the same agent don't lose records the way read-modify-write would.

Subcommands:

- `lint-file` (PostToolUse)
  - Read `tool_input.file_path`; resolve it against the working root.
  - Ignore paths outside the working root, `node_modules`, `out`, `dist`.
  - Ignore extensions other than `.ts`, `.mts`, `.vue`, `.js`, `.mjs` (the same set as `lint-staged`).
  - Run `process.execPath <root>/node_modules/eslint/bin/eslint.js --max-warnings 0 --no-cache <path>` with `cwd: root`, not `npx`. This takes about 1.5–2 s, mostly building the type-aware program. A cache wouldn't help: the file has just changed, so it always misses (measured 1.5 s after a change vs 0.6 s for an unchanged file). `--no-cache` also keeps parallel agents off `.eslintcache`.
  - If the root has no `node_modules` (a fresh native worktree), skip linting and print a one-line stderr note, exit 0.
  - Append `{ path, root }` to this agent's record file.
  - On failure, write the ESLint output (trimmed to the first ~20 problems) to stderr and exit 2. The edit has already happened; this only reports.
  - Consider reporting Prettier-only problems as a one-line hint, not exit 2. Mid-refactor edits often leave a transient unused import, and blocking feedback on each step is noisy.
- `guard` (PreToolUse, `Bash` and, on Windows, `PowerShell`; file-tool rules live in `permissions.deny`)
  - Tokenize like a shell: single and double quotes, backslash escapes (POSIX only; in PowerShell, `` ` `` is the escape and `\` is a path separator). Matching uses each argument's **resolved value**, so `".env"` is the same as `.env`. Normalize `\` to `/` before path matching, so `"C:\repo\.env"` matches.
  - Split into segments on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines. Treat the contents of `$(...)` and backticks as further segments.
  - In each segment, strip leading `VAR=value` assignments. For git, also strip global options (`-C <path>`, `-c <k>=<v>`, `--git-dir=…`, `--work-tree=…`) before matching the subcommand.
  - An argument is an **env path** if its value, or the part after `=` in `--opt=value` (`--file=.env`, `--exclude-from=…`), or the part after the last `:` of a git object spec (`HEAD:.env`, `:.env`, `main:apps/api/.env.local`), matches `(^|/)\.env(\.[\w.-]+)?$` and isn't `.env.example`.
  - Block, with a short stderr reason and exit 2:
    - any env-path argument, whatever the program (`cat`, `type`, `grep`, `sed`, `awk`, `python`, `cp`, `base64`, `git show`, `<` redirection, ...). The one exemption is the **pattern** argument of `grep`/`rg` (the first non-option argument, or the value after `-e`): this codebase is about `.env` files, and `rg '\.env\.'` over `src` is routine. Quoting alone never exempts an argument, so `echo ".env"` is blocked too, and that false positive is accepted.
    - recursive `grep` (`-r`, `-R`, `--recursive`, combined flags) whose search path is missing, `.`, `./` or the repo root, unless it has an `--exclude=.env*`-style exclusion. Unlike `rg`, grep ignores `.gitignore` and reads hidden files, so `grep -r "" .` would print the root `.env`. The reason tells Claude to search `src`/`tests`, or to use `rg` or the Grep tool.
    - `rg` with ignore rules off and hidden files on (`-uu`, `-uuu`, or `-u`/`--no-ignore*` together with `--hidden`). Plain `rg --hidden` still respects `.gitignore`, which ignores `.env*`, so it's allowed.
    - `git reset` with `--hard` anywhere in the segment (`git reset HEAD --hard`); `git clean` with `-f`; `git checkout` with a `.` or `--` pathspec (`git checkout .`, `git checkout -- src`); `git restore` without `--staged`
    - `git push` with `--force`, `-f`, `--force-with-lease` or a `+refspec`
    - `rm` with both `-r` and `-f` in any form (`-rf`, `-fr`, `-r -f`, `--recursive --force`), `Remove-Item -Recurse`
    - `npm publish`
  - Exit 0 with no output otherwise. Never return a Claude permission decision from this hook.
  - It's still best-effort, and the plan says so: variables (`f=.env; cat $f`), `eval`, globs (`cat .en*`), and interpreters building paths themselves (`node -e "fs.readFileSync('.'+'env')"`) get through. Section 12's tests list exactly what it catches. If Bash reads of `.env` ever need a real boundary, use the sandbox's filesystem read restrictions, not more regex.
- `typecheck` (Stop)
  - Exit 0 immediately when `stop_hook_active` is true.
  - Read every record file for this `session_id` (the main agent's and each subagent's). Exit 0 unless one lists a `.ts`, `.mts` or `.vue` path. The user's own uncommitted work must never trigger it.
  - For each distinct `root` in those records, run the typecheck from 6.1 with `cwd: root`. Skip a root without `node_modules`, and say so in one stderr line without blocking.
  - On success, delete the session's record files. On failure, write condensed output (first ~20 errors, with the root when there are several) to stderr and exit 2.

### 6.5 Wire the hooks

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PROJECT_DIR}/scripts/claude-hook.mjs", "lint-file"],
            "timeout": 60
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PROJECT_DIR}/scripts/claude-hook.mjs", "guard"],
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PROJECT_DIR}/scripts/claude-hook.mjs", "typecheck"],
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

- Use exec form (`command` + `args`) for every hook. It runs no shell, and Claude Code substitutes `${CLAUDE_PROJECT_DIR}` into each `args` element on every platform. Shell form would run under Git Bash or, without it, PowerShell, where `$CLAUDE_PROJECT_DIR` doesn't expand (`$env:` is needed). `node` resolves to `node.exe` on Windows, which exec form can spawn; `.cmd` shims can't be. Test once on a Windows machine without Git Bash if possible.
- The script path comes from `CLAUDE_PROJECT_DIR` (the starting checkout). Everything the script acts on comes from the input's `cwd` (6.4), so worktree edits are linted and typechecked in the worktree.
- The PostToolUse matcher is `Edit|Write`. `MultiEdit` is a legacy tool name; current versions route all file edits through `Edit`/`Write`.
- The guard's matcher includes `PowerShell`: on Windows, Claude Code can run commands through its PowerShell tool instead of Bash, and a `Bash`-only matcher would skip the guard there.
- Do not add a second `SessionStart` reminder. Cymbal owns that.
- With the cymbal nudge also on `PreToolUse` Bash, an exit 2 from the guard is treated as `deny`, and deny beats the nudge's `allow`. The acceptance test below checks that.

### 6.6 Add a short navigation note to root CLAUDE.md

Add three to five lines, not cymbal's full primer. The SessionStart reminder already carries the primer. This note exists for what the primer lacks: the `.vue` exception and the review scope. It also reaches opencode on Windows and any subagent that doesn't get the SessionStart context.

> Use cymbal for TypeScript navigation (`investigate`, `trace`, `impact`, `changed`, `outline`, `show`) before grep. Cymbal does not index `.vue`; use Grep/Read for renderer components. For your own changes, `cymbal changed --base "$(git merge-base origin/main HEAD)" --no-federate` lists what they touch. Reviews compute their base from the PR (`/ev-review`), since stacked PRs aren't based on `main`.

### 6.7 opencode parity

`.claude/settings.json` hooks do not run in opencode. Add a small project plugin, `.opencode/plugins/envvault-guard.js`, whose `tool.execute.before` passes the tool call to `node scripts/claude-hook.mjs guard` (mapping opencode's tool names and input shape) and throws on exit 2. Mirror the deny/ask lists in opencode's `permission` config, using the syntax of the installed opencode version. Leave `lint-file`/`typecheck` out of opencode unless it proves needed.

### Acceptance

- `npm run check` prints a compact summary and fails correctly, on macOS and on Windows.
- After Claude has `cd`'d into `src/`: Read `../.env`, Edit `../out/x`, Write `../package-lock.json` and Edit `../tests/fixtures/...` are all refused.
- Reading `.env` with Read is blocked. Grep over `.env` is blocked by the best-effort Read rule.
- The guard blocks every case section 12 marks 2 and allows every case marked 0: quoted and unquoted paths, Windows `\` paths, redirection, `$(...)`, `--file=`, `git show HEAD:.env`, recursive grep over the root, `git -C`, `git reset HEAD --hard`, `git checkout .`, `+refspec`, newline-separated compounds. Other Bash reads of `.env` are best-effort, and nothing here claims more.
- `rg foo; rm -rf out` is blocked even with the cymbal nudge installed.
- A TypeScript edit with a lint error returns feedback immediately.
- In a worktree session (`claude --worktree`, after `scripts/worktree.mjs` setup), an edit with a type error is linted and typechecked in the worktree, not the main checkout.
- Two parallel subagents in the main checkout each edit one `.ts` file; at Stop, both edits are typechecked (both record files are read).
- A subagent with `isolation: "worktree"` that edits a `.ts` file produces a visible "skipped: no node_modules in <root>" note from lint and from Stop, not silent success (see 9.2 for why editing subagents shouldn't use it yet).
- Stop runs typecheck only after this session edited a `.ts`/`.vue` file, and not because of the user's own uncommitted changes.
- Cymbal nudge still fires once; no duplicate reminders.

## 7. Phase 2: navigation and check skills

Goal: keep verbose exploration and test output out of the main context.

New procedures go in `.claude/skills/<name>/SKILL.md`. `.claude/commands/` still works, but skills support `context: fork` + `agent:` (run in a subagent), `disable-model-invocation` (manual `/name` only) and supporting files. A skill with `context: fork` gets only its own content as the subagent prompt, so it must be self-contained.

### 7.1 `navigator` agent

File: `.claude/agents/navigator.md`. The built-in `Explore` agent overlaps with it. The reasons to keep a custom one are the cymbal-first prompt, the `.vue` exception and haiku pricing.

```markdown
---
name: navigator
description: Read-only cymbal-first code navigation. Answers where symbols are, who calls them, and what a diff touches.
tools: Bash, Read, Grep, Glob
model: haiku
---

Use cymbal before grep:

- cymbal investigate <symbol> for orientation
- cymbal trace <symbol> for dependencies
- cymbal impact <symbol> --no-tests for production blast radius
- cymbal changed --base <base> --no-federate for diff scope, with the base you were given
  (otherwise "$(git merge-base origin/main HEAD)")
- cymbal outline <file> before reading it
- cymbal show <file:Lx-Ly> for targeted ranges
- cymbal search <query> before grep

If `git worktree list` shows more than one worktree, add --no-federate to every cymbal command,
or results from other branches' worktrees get mixed in.

Cymbal does not index .vue, Markdown, JSON or the vault fixture; use Grep/Read for those.
It does index YAML, but symbols there are thin; grep YAML for keys.
Renderer call sites of window.envvault are in .vue files, so grep for them.

Return file:line references and a short explanation. Do not paste whole files.
Do not edit anything.
```

### 7.2 Drop the `verifier` agent

With `verify.mjs` printing only failures and a three-line summary, a subagent adds a cold start and saves almost no context. `/check` runs it directly.

Claude may invoke it too, with no `disable-model-invocation`: the Stop hook only typechecks, so this is how Claude verifies its own work with tests. The description says when to use it, so Claude picks it up after code changes.

Don't name it `verify`. A project `verify` skill would replace the bundled `/verify`, which builds and runs the app to confirm a change. That's a different job, and a useful one for this Electron app.

File: `.claude/skills/check/SKILL.md`

```markdown
---
name: check
description: Run lint, typecheck and tests with a compact summary. Use after changing code, before saying work is done.
allowed-tools: Bash(npm run check:*), Bash(npx vitest:*)
---

Run `npm run check $ARGUMENTS`. Report the summary lines and, for each failure, the command, the
first useful error and the file to inspect. Do not paste passing output.
```

Revisit only if failing output still floods the context in practice. If so, add `context: fork` with a haiku agent.

### 7.3 `/navigate`

File: `.claude/skills/navigate/SKILL.md`

```markdown
---
name: navigate
description: Answer a code-navigation question with cymbal.
argument-hint: <question or symbol>
context: fork
agent: navigator
background: false
disable-model-invocation: true
---

Answer: $ARGUMENTS
Return file:line references and a short explanation.
```

`background: false` makes the turn wait for the answer. A forked skill otherwise runs in the background by default, and the answer arrives later.

### Acceptance

- `/navigate who calls applyMerge` returns call sites in the same turn, without dumping files.
- `/check` returns only the summary on success.
- A seeded lint error is reported with the file and rule.

## 8. Phase 3: review orchestration

Goal: turn a branch diff into focused, parallel reviews.

### 8.1 Diff scoping

Every review starts by fixing the base. The base is the PR's base branch, which for a stacked PR is the branch below it, not `main`:

```sh
BASE_REF=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || true)
BASE=""
if [ -n "$BASE_REF" ] && git fetch origin "$BASE_REF" 2>/dev/null; then
  BASE=$(git merge-base "origin/$BASE_REF" HEAD 2>/dev/null || true)
fi
if [ -z "$BASE" ] && [ -n "$BASE_REF" ]; then
  BASE=$(git merge-base "$BASE_REF" HEAD 2>/dev/null || true)   # offline or local-only parent
fi
if [ -z "$BASE" ]; then
  BASE=$(git merge-base origin/main HEAD 2>/dev/null || true)  # no PR yet
fi
if [ -z "$BASE" ]; then
  echo "Cannot determine review base" >&2
  exit 1
fi
echo "base: ${BASE_REF:-main (no PR)} @ $BASE"
cd "$(git rev-parse --show-toplevel)"
{ git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } | sort -u   # file list
command -v cymbal >/dev/null && cymbal changed --base "$BASE" --no-federate
```

The script stops instead of reviewing against an empty base. When it falls back from the PR's base to `main`, it says so in the `base:` line.

The file list joins tracked changes (deletions included) with **untracked, non-ignored** files. Without the second half, a new file Claude created would never be classified or reviewed. `--exclude-standard` applies `.gitignore`, so an untracked `.env` never enters the list. Neither `git diff` nor `cymbal changed` sees untracked files, so reviewers read new files whole (they're new, so that's the diff) and the summary notes they had no symbol-level impact data.

Use `git diff "$BASE"` (working tree), not `origin/main...HEAD` (commits only), so both views include uncommitted edits. Without cymbal (e.g. in CI, section 10), reviewers work from the file list and `git diff "$BASE" -- <file>` plus grep, and say the review had no symbol-level impact data.

Classify by **paths from `git diff --name-only`**, never by whether cymbal found symbols. First match wins:

| Paths                                                                                                                                                                                                                                                                                             | Class    | Reviewers                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `electron.vite.config.ts` (CSP), `electron-builder.yml` (fuses), `build/**` (entitlements), `resources/**`, `vite.cli.config.mts`, `eslint.config.mjs` (import bans), `package.json`, `package-lock.json`, `.github/**`, `.husky/**`, `scripts/deploy-*`, `tests/fixtures/**`, `docs/security.md` | security | security-reviewer                                                          |
| `src/**` (including `.vue`), other `scripts/**`                                                                                                                                                                                                                                                   | code     | by area, see 8.3                                                           |
| `tsconfig*.json`, `vitest.config.mts`, `.prettierrc.yaml`, `.gitattributes`                                                                                                                                                                                                                       | config   | security-reviewer, only for whether it narrows what lint/types/tests cover |
| other `tests/**`                                                                                                                                                                                                                                                                                  | tests    | the area reviewer for the code under test, if one runs                     |
| other `*.md`, `docs/**`, images                                                                                                                                                                                                                                                                   | docs     | none; check docs against the code                                          |

A warning about unparseable files is expected for Markdown and images. `.vue` changes never appear as symbols, so reviewers grep those files directly.

For each changed symbol, reviewers may run:

```sh
cymbal impact <symbol> --no-tests
cymbal trace <symbol>
```

### 8.2 Reviewer agents

Create read-only agents:

| File                                  | Tools                  | Model  | Focus                                  |
| ------------------------------------- | ---------------------- | ------ | -------------------------------------- |
| `.claude/agents/security-reviewer.md` | Read, Grep, Glob, Bash | sonnet | Root invariants and `docs/security.md` |
| `.claude/agents/ipc-reviewer.md`      | Read, Grep, Glob, Bash | sonnet | Five-place channel checklist           |
| `.claude/agents/sync-reviewer.md`     | Read, Grep, Glob, Bash | sonnet | CAS, locks, keys, autopull, backups    |

Shared rules:

- Read the root `CLAUDE.md` and the relevant area `CLAUDE.md` only; `docs/security.md` for the security reviewer.
- **The checklist is the "Invariants to preserve" section of the root `CLAUDE.md`, plus the area file.** Prompts list only review-specific checks that the docs don't already state as rules. This keeps prompts and docs from drifting.
- Start from the base and file list computed in 8.1, which the orchestrating skill passes in.
- Report findings as `severity`, `file:line`, `problem`, `suggested direction`.
- No edits, no patches, no full-file dumps.
- If there are no findings, say so in one line.

Review-specific checks (in addition to the CLAUDE.md invariants):

- Security: `tests/fixtures/vault-format2` unchanged; CSP plugin and `electronFuses` unchanged unless the diff is about them; no new `console.*` besides `console.error`; no new channel that carries values or the setup code; new git or gh calls go through `git()`/`runGit()`/`runGh`.
- IPC: all five places present, and step 4 (handler) in particular, since it's the one that still compiles when forgotten; `z.strictObject` or `NoArgs`; renderer calls in `.vue` use `call`/`run` with plain objects (grep, since cymbal misses `.vue`).
- Sync: no `exclusive()` inside another `exclusive()` or inside `sync.ts`; key taken inside `exclusive()`; every write checks `expected`; automatic pull acts only on `vault-newer` and never merges; plaintext buffers zero-filled.

### 8.3 `/ev-review` skill

File: `.claude/skills/ev-review/SKILL.md`. The name avoids the built-in `/code-review` (alias `/review`) and `/security-review`; a project skill with the same name would replace the built-in.

```markdown
---
name: ev-review
description: Review the current branch against its PR base with parallel area reviewers.
disable-model-invocation: true
allowed-tools: Bash(gh pr view:*), Bash(git fetch:*), Bash(git merge-base:*), Bash(git diff:*), Bash(cymbal changed:*), Read, Grep, Glob, Agent
---

1. Compute the base and file list as in docs/claude-orchestration-plan.md 8.1. If cymbal isn't
   on PATH, continue with the file list and git diff alone, and say so in the summary.
2. Classify by path (first match wins). Docs-only: check the docs against the code and stop.
3. Otherwise run in parallel, passing the base and file list to each:
   - security-reviewer: always
   - ipc-reviewer: src/shared, src/main/schemas.ts, handlers.ts, ipc.ts, src/preload, or
     window.envvault call sites in src/renderer changed
   - sync-reviewer: src/main/sync.ts, autopull, bases, vault, editor, src/main/store or git.ts changed
4. Synthesize: blockers first, then warnings, then nits. Cite file:line. Drop duplicates.
5. Do not edit unless the user asks for fixes.
```

Once the plan is done, move step 1's commands into the skill itself, so the skill doesn't depend on this doc.

### 8.4 `/ev-security` skill

Same as `/ev-review`, but only the security reviewer and a short summary. Use the built-in `/security-review` and `/code-review` alongside it for a generic pass; these skills add the repo's invariants.

### 8.5 `/ev-channel` and `/ev-impact`

- `/ev-channel <name>`: use `cymbal investigate`/`cymbal search` to locate the five places, then implement the channel and its test. This skill edits, so leave `context: fork` off and run it in the main session.
- `/ev-impact <symbol>`: `context: fork`, `agent: navigator`, `background: false`. Run `cymbal impact` and `cymbal trace`, summarize blast radius, do not edit.

### Acceptance

- `/ev-review` on a branch produces the base, the file classes and the changed symbols first.
- A stacked branch is reviewed against its parent branch, not `main`. A branch with no PR falls back to `origin/main` and says so. With no resolvable base, the review stops.
- A docs-only diff skips code reviewers; a `.vue`-only, `electron.vite.config.ts`-only or `docs/security.md`-only diff does not.
- With cymbal removed from PATH, `/ev-review` still completes from the file list and says it had no symbol data.
- A new, untracked `src/core/newfile.ts` with a seeded issue is classified and reviewed. A new ignored `.env` does not appear in the file list. A deleted tracked file does.
- Reviewers return `file:line` findings without editing.
- A deliberately introduced violation is caught by the relevant reviewer. Suggested seeds: a handler missing for a new channel, a `console.log` of a value, `exclusive()` nested inside another.

## 9. Phase 4: skills, worktrees and parallel work

### 9.1 Skills

Add on-demand skills; do not duplicate area `CLAUDE.md` content.

| Skill              | Contents                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `envvault-channel` | Five-place channel procedure, schema rules, `Result`/`AppError`, renderer `call`/`run`, test pattern |
| `envvault-crypto`  | Format 2, `vaultKey`, `fileTagger`, AADs, `parseMeta` bounds, fixture invariant                      |
| `envvault-ui`      | Settings tabs and `saveSettings`, no `v-html`, CSS in `main.css`, no Node imports                    |
| `envvault-debug`   | CDP at port 9222, `window.envvault`, dev profiles, packaged-app limits                               |

Each skill should link to the relevant `CLAUDE.md` instead of restating it. Merge `envvault-channel` with `/ev-channel` (8.5); two skills for one procedure is the duplication this plan avoids. Use `paths:` frontmatter where it helps, e.g. `envvault-ui` on `src/renderer/**`, so the skill loads only when relevant.

### 9.2 Worktrees

Claude Code creates worktrees for `claude --worktree <name>` sessions and for Agent calls with `isolation: "worktree"`. Both use `.claude/worktrees/`, which 6.3 gitignores.

A native worktree starts without `node_modules` or a cymbal index. Lint and the Stop typecheck skip such a root (6.4), so an editing agent there gets no checks. Until that's solved:

- **Editing in a worktree** happens in a `claude --worktree` session that has run `scripts/worktree.mjs` first (below).
- **Editing subagents run in the main checkout**, one owner per file (9.3), not with `isolation: "worktree"`. Reviewers and the navigator are read-only and need no isolation.

Later option: a `WorktreeCreate` hook would make isolated editing subagents safe. It **replaces** Claude Code's own worktree creation, so it must run `git worktree add` itself and do the setup below, with all setup output on stderr; Claude Code reads stdout as the worktree path, and any non-zero exit fails creation. Pair it with a `WorktreeRemove` hook running `git worktree remove`, because removal of hook-created worktrees goes through that hook. Each isolated subagent would then pay an `npm ci` (tens of seconds), so adopt it only if parallel editing subagents become routine.

Add `scripts/worktree.mjs` (Node, cross-platform) as the setup step, used either standalone or right after the native command:

1. Validate a slug against `^[a-z0-9][a-z0-9-]*$`.
2. If the worktree doesn't exist, `git worktree add .claude/worktrees/<slug> -b <branch>`.
3. Run `npm ci --ignore-scripts` in the worktree. This skips the Electron download, so `npm run dev`/`npm start` won't work there; `npm run check` will.
4. Run `npm run prepare` (Husky) in the worktree. Without it, pre-commit **silently does nothing** there. `core.hooksPath` is `.husky/_`, resolved relative to each worktree. `.husky/_/` is generated and gitignored, so a fresh worktree doesn't have it, and `--ignore-scripts` skipped `prepare`.
5. Run `cymbal index . --exclude 'out/**' --exclude 'dist/**'` in the worktree.
6. Print the absolute path and the branch.

### 9.3 Parallel rules

- Parallelize renderer, core and docs work.
- Serialize work touching `src/shared/`, `src/main/schemas.ts`, `src/main/handlers.ts`, `src/main/ipc.ts` and `src/preload/`.
- Assign one owner per file. Do not let two agents edit the same file.
- Run tests and builds inside the owning worktree; `out/`, `dist/` and `.eslintcache` are shared otherwise.
- Run `/ev-review` inside the branch worktree.
- Use `--no-federate` for review commands. cymbal never indexes a nested worktree's files into the main index; it detects them and skips them, even without a `.gitignore` entry (tested). But once a worktree has its own index, plain `cymbal search` in the main checkout federates into it and returns the other branch's symbols. So the navigator also passes `--no-federate` whenever `git worktree list` shows more than one worktree.
- Graph traversal (`trace`, `impact`, `refs`) stays in the owning worktree; index each worktree you want included.
- Remove finished worktrees (`git worktree remove`) so federation and disk use don't grow.

### Acceptance

- Two worktrees can run `npm run check` concurrently without interfering.
- Each worktree index excludes `out/` and `dist/`.
- A review in one worktree does not mix in symbols from another.
- In a worktree set up by the script, committing a staged `.ts` file with a lint error is rejected by pre-commit.

## 10. Phase 5: optional CI orchestration

CI already runs lint, tests and build. Do not add cymbal to CI by default.

Optional Claude review job:

- Use `anthropics/claude-code-action` pinned by SHA.
- Run only on same-repository pull requests; never use `pull_request_target`.
- Permissions: `contents: read`, `pull-requests: write`.
- Prompt: read `CLAUDE.md` and `docs/security.md`, run `/ev-security` against the PR's base. Without cymbal it uses the git-only fallback (8.1, 8.3), which keeps "no CI dependency on cymbal" true. The review loses symbol-level impact, which matters little for a security pass driven by the file list.
- Check out with `fetch-depth: 0`, or fetch the base branch, so `merge-base` works.
- Keep it advisory; the required gate remains lint, tests and build.
- Do not grant push or merge permissions; restrict the action's allowed tools to read-only ones and `gh pr comment`.
- Do not expose `ANTHROPIC_API_KEY` to fork PRs.

If cymbal is used in CI, install a pinned binary; accept that the index is rebuilt per ephemeral runner. This is optional and not required for the local setup.

## 11. Proposed file tree

```
~/.claude/hooks/
  cymbal-nudge.mjs           # user scope, strips permissionDecision (5.3)
.claude/
  settings.json
  settings.local.json        # gitignored
  worktrees/                 # gitignored, native and scripted worktrees
  agents/
    navigator.md
    security-reviewer.md
    ipc-reviewer.md
    sync-reviewer.md
  skills/
    check/SKILL.md
    navigate/SKILL.md
    ev-review/SKILL.md
    ev-security/SKILL.md
    ev-channel/SKILL.md      # merged with envvault-channel
    ev-impact/SKILL.md
    envvault-crypto/SKILL.md
    envvault-ui/SKILL.md
    envvault-debug/SKILL.md
.opencode/
  plugins/envvault-guard.js  # 6.7
opencode.json                # 6.7, opencode permissions
scripts/
  checks.mjs                 # check commands, shared by verify.mjs and claude-hook.mjs
  verify.mjs
  claude-hook.mjs
  review-scope.mjs           # 8.1 base, file list, classes and reviewers
  worktree.mjs
tests/
  claude-hook.test.ts        # guard cases, hook no-ops, verify.mjs vs package.json
```

## 12. Verification checklist

Run these after each phase:

```sh
npm run lint
npm run typecheck
npm test
npm run check
```

Cymbal:

```sh
cymbal ls --names | grep -E '^(out|dist)/'      # empty
cymbal investigate listRepos | head -20         # only src/main/sync.ts
cymbal changed --base "$(git merge-base origin/main HEAD)" --no-federate   # outside a PR review
echo '{"tool_name":"Bash","tool_input":{"command":"rg foo; rm -rf out"}}' \
  | node ~/.claude/hooks/cymbal-nudge.mjs       # no permissionDecision
grep -c 'cymbal hook nudge' ~/.claude/settings.json   # 0 (only the wrapper)
```

Hook tests (run on macOS and Windows; on Windows use `echo %errorlevel%` or `$LASTEXITCODE`):

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"cat .env"}}' \
  | node scripts/claude-hook.mjs guard; echo $?  # 2

echo '{"tool_name":"Bash","tool_input":{"command":"cat .env.example"}}' \
  | node scripts/claude-hook.mjs guard; echo $?  # 0

echo '{"tool_name":"Bash","tool_input":{"command":"rg foo; rm -rf out"}}' \
  | node scripts/claude-hook.mjs guard; echo $?  # 2

echo '{"tool_name":"Bash","tool_input":{"command":"git push origin +main"}}' \
  | node scripts/claude-hook.mjs guard; echo $?  # 2

echo '{"stop_hook_active":false,"session_id":"none"}' \
  | node scripts/claude-hook.mjs typecheck; echo $?  # 0, no edits recorded
```

These belong in a Vitest file (`tests/claude-hook.test.ts`, spawning the script with JSON on stdin) rather than only in this list. Then CI runs them on macOS and Windows. Guard cases, as `command → expected exit`:

| Command                               | Exit |
| ------------------------------------- | ---- |
| `grep -n TOKEN .env`                  | 2    |
| `grep -n TOKEN ".env"`                | 2    |
| `cat ".env"`                          | 2    |
| `sed -n 1p apps/api/.env.local`       | 2    |
| `sed -n 1p "apps/api/.env.local"`     | 2    |
| `node -e 1 < .env`                    | 2    |
| `node -e 1 < ".env"`                  | 2    |
| `type "C:\repo\.env"` (PowerShell)    | 2    |
| `cat $(echo .env)`                    | 2    |
| `grep --file=.env x src`              | 2    |
| `git show HEAD:.env`                  | 2    |
| `git show :.env`                      | 2    |
| `grep -r "" .`                        | 2    |
| `grep -rn TOKEN`                      | 2    |
| `rg -uu TOKEN`                        | 2    |
| `git -C . reset --hard`               | 2    |
| `git reset HEAD --hard`               | 2    |
| `git checkout .`                      | 2    |
| `git status` + newline + `rm -rf out` | 2    |
| `rm -r -f out`                        | 2    |
| `cat ".env.example"`                  | 0    |
| `rg '\.env\.' src`                    | 0    |
| `rg --hidden .env`                    | 0    |
| `grep -rn ".env.local" docs`          | 0    |
| `grep -rn TOKEN src`                  | 0    |
| `git checkout feature/x`              | 0    |
| `git restore --staged src/a.ts`       | 0    |
| `git push origin feature/x`           | 0    |

In a live session: ask Claude to Read `.env` and to Edit a file under `tests/fixtures/`. Both should be refused by `permissions.deny`. Then have it `cd src` and try Read `../.env`, Edit `../out/x` and Write `../package-lock.json`; all three should be refused too.

Claude settings:

- One cymbal `PreToolUse` entry, pointing at the wrapper in exec form; no raw `cymbal hook nudge` entry.
- One cymbal `SessionStart` entry.
- Project settings contain no cymbal hooks.

## 13. Risks and mitigations

| Risk                                          | Mitigation                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Cymbal nudge auto-approves compound commands  | User-scope wrapper strips `permissionDecision`; re-check after `cymbal hook install` or upgrades                           |
| Duplicate cymbal hooks after reinstall        | Count entries by command (`grep -c 'cymbal hook nudge'`), not by marker                                                    |
| Cymbal indexes `out/` again                   | Re-run full index with excludes after rebuilds or format upgrades; verify with `ls --names`                                |
| Cymbal misses `.vue`                          | Classify diffs by path; reviewers grep `.vue`; state the exception in `CLAUDE.md`                                          |
| Security-relevant config treated as "no code" | `electron.vite.config.ts`, `electron-builder.yml`, `build/**`, `package.json` always get security review                   |
| Wrong review base on stacked PRs              | Base from `gh pr view --json baseRefName`, fetched, then `merge-base`                                                      |
| Project skills shadow built-ins               | `ev-` prefix; check `/skills` after adding one                                                                             |
| Competing PreToolUse hooks                    | Exit 2 routes as `deny`, which beats `allow`; covered by an acceptance test                                                |
| Hook latency                                  | Direct eslint bin (1.5–2 s, type-aware; a cache can't help a just-edited file); typecheck only on Stop after session edits |
| Hooks act on the wrong tree in a worktree     | Working root from the input's `cwd`; `CLAUDE_PROJECT_DIR` only locates the script                                          |
| Parallel subagents lose each other's edits    | One record file per `session_id` + `agent_id`; Stop reads them all                                                         |
| Pre-commit silently off in worktrees          | `scripts/worktree.mjs` runs `npm run prepare`; acceptance test commits a lint error                                        |
| Stop hook blocks on the user's own WIP        | Typecheck keyed on files this session edited, not `git status`                                                             |
| Full test suite too slow per turn             | Keep it in `/check`, not in Stop                                                                                           |
| Reviewers too expensive                       | Read-only, sonnet, diff-scoped, cymbal-first; launched only for touched areas                                              |
| Reviewer checklists drift from CLAUDE.md      | Prompts reference the invariants section; only review-specific checks live in prompts                                      |
| Worktree federation mixes branches            | `--no-federate` for reviews, and for navigation when several worktrees exist; remove finished worktrees                    |
| New files skip review                         | File list adds `git ls-files --others --exclude-standard`                                                                  |
| Isolated editing subagents run unchecked      | Editing subagents stay in the main checkout; skipped checks print a note; `WorktreeCreate` hook later if needed            |
| Deny rules miss the root after `cd`           | Every relative path rule has a `/`-anchored twin                                                                           |
| Guard skipped on Windows PowerShell tool      | Guard matcher is `Bash\|PowerShell`                                                                                        |
| Windows hook and spawn differences            | `process.execPath` + `npm_execpath`/package bins; no `npm.cmd`, `shell: true`, `jq` or POSIX shell                         |
| Env values exposed                            | `permissions.deny` for Read/Edit (Grep/Glob best-effort); token-level Bash guard, tested; cymbal indexes source only       |
| Prefix rules bypassed (`+refspec`, `git -C`)  | Guard checks each segment; treat both as seatbelts; sandbox if a boundary is needed                                        |
| opencode has no guard                         | Project plugin calls the same `guard` script                                                                               |
| Agents commit or push unexpectedly            | Keep git commit/push in `ask`; no auto-commit policy                                                                       |
| Local settings committed                      | `.gitignore` `settings.local.json`                                                                                         |

## 14. Rollback

1. Restore `~/.claude/settings.json` from the backup and delete `~/.claude/hooks/cymbal-nudge.mjs`.
2. Run `cymbal hook uninstall claude-code` and `cymbal hook uninstall opencode` if you want the hooks gone.
3. Delete the project `.claude/` and `.opencode/` configuration and `scripts/verify.mjs`, `scripts/claude-hook.mjs`, `scripts/worktree.mjs`; remove the `check` script from `package.json`.
4. Remove worktrees with `git worktree remove` (then `git worktree prune`).
5. Optionally delete cymbal's OS cache index and reindex without exclusions.

## 15. Recommended order and effort

| Phase | Work                                                                                        | Effort  | Value  |
| ----- | ------------------------------------------------------------------------------------------- | ------- | ------ |
| 0     | Check hooks, nudge wrapper, clean index                                                     | 30 min  | High   |
| 1     | `npm run check`, permissions, hook script, PostToolUse lint, Stop typecheck, opencode guard | 2–3 h   | High   |
| 2     | `navigator`, `/check`, `/navigate`                                                          | 45 min  | High   |
| 3     | Security/IPC/sync reviewers, `/ev-review`, `/ev-security`                                   | 1–2 h   | High   |
| 4     | Skills, worktree setup script, parallel rules                                               | 1.5–2 h | Medium |
| 5     | Optional CI review action                                                                   | 30 min  | Low    |

Commit the current `CLAUDE.md` split on its own first, so the orchestration changes start from a clean base. Do phase 0 before writing any project `.claude` files: 5.3 changes what "allowed" means for everything after it. Phase 1's `verify.mjs` and `claude-hook.mjs` are ordinary repo scripts. They get lint, typecheck and a Windows CI run like everything else, so test them on Windows before relying on them.

## 16. Review decisions (2026-10-21)

Reviews proposed R1–R16 (second) and R17–R22 (third). Each was checked against the Claude Code docs (hooks, skills, permissions), the installed tools and the repo before it was accepted. Accepted items are applied in the sections listed.

| ID  | Decision            | Where                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Applied             | 6.4, 6.5, Ph.1 acc.     | Docs confirm `CLAUDE_PROJECT_DIR` stays at the starting checkout and the input's `cwd` follows Claude into a worktree.                                                                                                                                                                                                                                                                                                                            |
| R2  | Applied             | 5.3, 6.5                | Docs confirm exec form (`args`) substitutes path placeholders with no shell, and that Windows shell form falls back to PowerShell without Git Bash.                                                                                                                                                                                                                                                                                               |
| R3  | Applied (guard)     | 6.2, 6.4, Ph.1 acc., 12 | Docs confirm Read rules cover Grep/Glob only best-effort. The guard matches env-file **path tokens** instead of a list of programs, which also catches redirections; `grep`/`rg` patterns are exempt, since this codebase searches for `.env` routinely. `**/.env` matches the root file (docs), so no extra `./.env` rule. Added `!` negation for a future `.env.example`, and anchored the fixture rule with `/`.                               |
| R4  | Applied, refined    | 6.4, Ph.1 acc.          | `agent_id` exists only inside subagents, so the file is keyed `<session>-<agent or main>`. Stop fires for the main agent only, so it reads every record file for the session. Roots without `node_modules` are skipped with a note, not blocked.                                                                                                                                                                                                  |
| R5  | Applied (fallback)  | 8.1, 8.3, 10            | Keeps the "no CI cymbal" non-goal. Added `fetch-depth: 0` for `merge-base` in CI.                                                                                                                                                                                                                                                                                                                                                                 |
| R6  | Applied             | 9.2                     | Confirmed: `core.hooksPath` is the relative `.husky/_`, and `.husky/_/` is gitignored.                                                                                                                                                                                                                                                                                                                                                            |
| R7  | Applied             | 7.1                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R8  | Applied, adjusted   | 8.1                     | Table is first-match-wins. `tsconfig*`, `vitest.config.mts`, `.prettierrc.yaml`, `.gitattributes` form a "config" class, checked only for whether they narrow what lint, types or tests cover. `eslint.config.mjs` stays in security: it enforces the store import bans.                                                                                                                                                                          |
| R9  | Applied             | 8.1, 6.6, 7.1, 12       | `origin/main` remains only for navigation outside a PR review, and is labelled so.                                                                                                                                                                                                                                                                                                                                                                |
| R10 | Applied             | 7.3, 8.5                | Docs confirm `background` defaults to `true` with `context: fork` (needs 2.1.218+; installed 2.1.306).                                                                                                                                                                                                                                                                                                                                            |
| R11 | Applied             | 7.2                     | `/check` is model-invocable. Not renamed to `verify`: bundled `/verify` runs the app, a different and useful job.                                                                                                                                                                                                                                                                                                                                 |
| R12 | Rejected            | 6.4                     | The 0.64 s "warm cache" figure is a cache hit on an unchanged file. PostToolUse always lints a file that just changed, so it always misses. Measured here: cold 1.5 s, unchanged 0.6 s, after a change 1.5 s. `--no-cache` stays.                                                                                                                                                                                                                 |
| R13 | Applied             | 6.1, 6.4                | Direct bins mirror the `package.json` scripts. A test keeps the arguments in sync, and the typecheck runner is shared with the hook.                                                                                                                                                                                                                                                                                                              |
| R14 | Applied             | 5.3, 5.2, 12            |                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R15 | Applied             | 5.5                     | Confirmed in `cymbal-opencode.js`: it rewrites the command with a notice and returns no decision.                                                                                                                                                                                                                                                                                                                                                 |
| R16 | Applied             | 0, 3, 5.2, 6.2, 6.5     | Confirmed: a scoped `grep -n x file.ts` gets no nudge. Docs list `MultiEdit` as a legacy tool name.                                                                                                                                                                                                                                                                                                                                               |
| R17 | Applied, extended   | 6.4, 6.5, Ph.1 acc., 12 | Quote-aware tokenizing, `\` normalized to `/`, values of `--opt=` and git `rev:path` specs checked. Extended: the guard matcher is now `Bash\|PowerShell`, because on Windows Claude Code can use its PowerShell tool and the hooks docs show that matcher. `echo ".env"` being blocked is accepted.                                                                                                                                              |
| R18 | Rejected            | 9.3, 7.1                | Tested in a scratch repo: cymbal detects nested worktrees and skips their files even without a `.gitignore` entry ("skipped 1 unindexed sibling worktree"). The real effect is **federation**: once a worktree is indexed, a plain `cymbal search` in the main checkout returns its symbols. So `--no-federate` now applies to navigation whenever several worktrees exist. No `.cymbal/` exclude needed; it exists only with `CYMBAL_DB`/Docker. |
| R19 | Applied, reduced    | 6.2, Ph.1 acc., 12      | `/**/.env` already covers the root `.env`, so `/.env` and `/.env.*` are left out. ~~`package-lock.json` needs no twin~~: wrong, as live testing showed (section 17), so `Edit(/package-lock.json)` is back. Added a caveat: `!` carve-outs can't reach `/`-anchored rules, so a future `.env.example` needs explicit variants there.                                                                                                              |
| R20 | Applied, adjusted   | 6.4, Ph.1 acc., 12      | Items 1, 3, 4, 5 as proposed. Item 2 narrowed. `rg --hidden .env` reads nothing ignored: `.env` is the pattern, and `--hidden` still respects `.gitignore`, so it stays allowed. Only `rg` with ignore rules off and hidden on is blocked. Recursive `grep` over the repo root is blocked, because grep ignores `.gitignore`; over `src`/`tests` it's fine. Residuals stated plainly, sandbox named as the real boundary.                         |
| R21 | Applied             | 8.1, 8.3 acc.           | `cd` to the top level first, so `ls-files` lists from the root.                                                                                                                                                                                                                                                                                                                                                                                   |
| R22 | Applied (read-only) | 9.2, Ph.1 acc.          | Docs: `WorktreeCreate` **replaces** git's worktree creation, must print only the path on stdout, and needs a paired `WorktreeRemove`. That costs an `npm ci` per subagent, so it's recorded as a later option. For now, editing subagents run in the main checkout; reviewers need no isolation. Skipped checks must print a note, and an acceptance test checks it.                                                                              |

## 17. Implementation notes (2026-10-21)

What was built, where it differs from the sections above, and what was verified. Commits: `811558d` (the `CLAUDE.md` split, on its own as section 15 asks), then the orchestration change.

### Differences from the plan

- **`Edit(/package-lock.json)` added** (6.2). Live testing from `src/` showed a bare-filename rule matches only under the current directory: a Write overwrote the root lock file. It was restored from `HEAD` at once, and the rule now has a `/` twin like the others. R19 had proposed this rule; my review of section 16 wrongly dropped it.
- **Edit records are `.jsonl`, appended** (6.4), not temp-file-and-rename: a rename would still lose a record when two edits of one agent race.
- **Non-blocking notes use JSON output** (6.4). Stderr on exit 0 never reaches Claude, so the "skipped: no node_modules" and "formatting only" notes go out as `systemMessage` (for the user) plus, in PostToolUse, `additionalContext` (for Claude). Blocking still uses exit 2 and stderr.
- **Prettier-only lint results don't block** (6.4's "consider"): they come back as a one-line note with the `prettier --write` command.
- **The guard also parses** `bash -c`/`pwsh -Command` strings, `for … in` lists and `. file`/`source file`. It skips heredoc bodies and comments, so commit messages written through a heredoc aren't blocked for mentioning `.env`. The shared tokenizer handles both shells.
- **Review scoping is `scripts/review-scope.mjs`**, not the inline `sh` of 8.1. It's cross-platform and deterministic, and it also classifies the files and picks the reviewers. Changes to the table: Markdown is docs wherever it lives (`src/**/CLAUDE.md` was showing up as code), and docs files never trigger an area reviewer. `.gitignore`, `.claude/**`, `.opencode/**`, `opencode.json` and `scripts/claude-hook.mjs` are security class, since they are the guardrails. Untracked renderer files are read from disk to see if they call `window.envvault`.
- **`scripts/checks.mjs`** holds the check commands; `verify.mjs` (`--list` prints them) and the Stop hook both use it. `tests/claude-hook.test.ts` checks them against `package.json`.
- **opencode** (6.7): project `opencode.json` at the root, using the `permission` object (`read`/`edit`/`bash`, last match wins). It's marked deprecated in the current schema, but it's the form 1.19.3 documents; newer versions take an ordered `permissions` array. Path patterns are listed both bare and with a `*/` prefix, because whether opencode matches relative or absolute paths isn't documented.
- **`scripts/worktree.mjs`** finds `npm-cli.js` through `npm` on PATH (Homebrew keeps it under the prefix, not beside the Node binary), runs it with `process.execPath`, and has `--setup-only` for worktrees `claude --worktree` already made.
- **`/check` passes its arguments** through (`npm run check -- <args>`). **`/ev-channel` is model-invocable**, so Claude loads it when adding a channel; it has no `context: fork`, since it edits.
- **CLAUDE.md** gained `npm run check` in Commands, a line on the hooks, and the navigation note (6.6). `tests/CLAUDE.md` lists the new test.

### Verified

- Phase 0: user settings backed up (`~/.claude/settings.json.bak-20261021-084822`). The nudge entry is now the exec-form wrapper (0 raw `cymbal hook nudge` entries), and `rg foo; rm -rf out` gets the note without an `allow`. The index has no `out/` or `dist/` files, and `cymbal investigate listRepos` points at `src/main/sync.ts`.
- `npm run check`: lint ok, typecheck ok, 773 tests passed / 1 skipped, about 26 s. A seeded Prettier problem fails it with the file and rule.
- Live in this session: the guard blocked `cat .env` and `rg …; rm -rf …` (the cymbal note arrived once, alongside). Read `.env`, Write under `tests/fixtures/`, Write under `out/` and, after the fix, Write `package-lock.json` were refused from the root and from `src/`. The lint hook reported on each edit, including transient mid-edit errors.
- Hooks: 48 cases in `tests/claude-hook.test.ts`, plus 44 ad hoc guard cases. `lint-file` blocks with `file:line rule` lines. The Stop typecheck blocks on a type error and no-ops without session records.
- Worktrees: `scripts/worktree.mjs` set one up in about 4 s. Pre-commit there rejected a staged lint error. The main checkout's hooks linted and typechecked the worktree's file in the worktree. A worktree without `node_modules` produced the "skipped" notes (per-agent record file `…-agent-1.jsonl`). Both test worktrees and branches were removed.
- opencode: the plugin blocks `cat .env` and allows `git status`; `opencode debug config` loads the project permissions.

### Not done or not yet verified

- Phase 5 (optional CI review job): not started; it needs an `ANTHROPIC_API_KEY` secret and a decision to run it.
- The skills and agents haven't been run end to end. A session started after these files exist should check that `/check`, `/navigate who calls applyMerge` and `/ev-impact listRepos` return in the same turn, and that `/ev-review` launches only the reviewers `review-scope.mjs` lists. It should also try the seeded violations from 8's acceptance.
- Windows: everything avoids shells and `.cmd` spawning, but nothing ran on Windows yet. CI will run `tests/claude-hook.test.ts` on Windows when this is pushed. The hooks' exec form and the PowerShell matcher still need one interactive check there.
- The `/` anchor inside a `claude --worktree` session (6.2's note) hasn't been checked.
