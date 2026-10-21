import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/claude-hook.mjs and scripts/verify.mjs are plain Node scripts for
// Claude Code (docs/claude-orchestration-plan.md); tested by running them.
const ROOT = join(__dirname, '..')
const HOOK = join(ROOT, 'scripts', 'claude-hook.mjs')

function hook(sub: string, input: object): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK, sub], {
    input: JSON.stringify(input),
    encoding: 'utf8'
  })
  return { status: r.status, stderr: r.stderr }
}

const guard = (command: string, tool = 'Bash'): number | null =>
  hook('guard', { tool_name: tool, cwd: ROOT, tool_input: { command } }).status

describe('guard', () => {
  it.each([
    'cat .env',
    'cat ".env"',
    'grep -n TOKEN .env',
    'grep -n TOKEN ".env"',
    'sed -n 1p apps/api/.env.local',
    'sed -n 1p "apps/api/.env.local"',
    'node -e 1 < .env',
    'node -e 1 < ".env"',
    'cat $(echo .env)',
    'bash -c "cat .env"',
    '. .env',
    'grep --file=.env x src',
    'git show HEAD:.env',
    'git show :.env',
    'grep -r "" .',
    'grep -rn TOKEN',
    'rg -uu TOKEN',
    'git -C . reset --hard',
    'git reset HEAD --hard',
    'git checkout .',
    'git checkout -- src',
    'git clean -fd',
    'git status\nrm -rf out',
    'rm -r -f out',
    'rg foo; rm -rf out',
    'git push origin +main',
    'git push --force-with-lease',
    'npm publish'
  ])('blocks %j', (command) => {
    expect(guard(command)).toBe(2)
  })

  it.each([
    'cat ".env.example"',
    "rg '\\.env\\.' src",
    'rg --hidden .env',
    'grep -rn ".env.local" docs',
    'grep -rn TOKEN src',
    'grep -rn --exclude=.env* TOKEN .',
    'git checkout feature/x',
    'git restore --staged src/a.ts',
    'git push origin feature/x',
    'git commit -m "fix .env handling"',
    "git commit -m \"$(cat <<'EOF'\nfeat: don't read .env\n\nRead(**/.env) stays denied\nEOF\n)\"",
    "cat > notes.md <<'EOF'\ncat .env\nEOF",
    'npm test 2>&1 | tail -5',
    'rm -r out',
    'echo ${HOME}/x'
  ])('allows %j', (command) => {
    expect(guard(command)).toBe(0)
  })

  it('reads PowerShell commands as PowerShell', () => {
    expect(guard('type "C:\\repo\\.env"', 'PowerShell')).toBe(2)
    expect(guard('Get-Content .env', 'PowerShell')).toBe(2)
    expect(guard('Remove-Item -Recurse out', 'PowerShell')).toBe(2)
    expect(guard('Get-ChildItem src', 'PowerShell')).toBe(0)
  })

  it('explains a block on stderr', () => {
    const r = hook('guard', { tool_name: 'Bash', cwd: ROOT, tool_input: { command: 'cat .env' } })
    expect(r.stderr).toMatch(/envvault guard.*env file/)
  })
})

describe('typecheck', () => {
  it('does nothing without edits recorded for the session', () => {
    expect(hook('typecheck', { session_id: 'no-such-session' }).status).toBe(0)
    expect(hook('typecheck', { session_id: 'x', stop_hook_active: true }).status).toBe(0)
  })
})

describe('lint-file', () => {
  it('ignores files outside the repository and other file types', () => {
    expect(
      hook('lint-file', { cwd: ROOT, tool_input: { file_path: '/elsewhere/a.ts' } }).status
    ).toBe(0)
    expect(hook('lint-file', { cwd: ROOT, tool_input: { file_path: 'README.md' } }).status).toBe(0)
  })
})

describe('verify.mjs', () => {
  it('runs exactly what the package.json scripts run', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'verify.mjs'), '--list'], {
      encoding: 'utf8'
    })
    const checks = JSON.parse(r.stdout) as Record<string, [string, string, string[]]>
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    expect(Object.keys(checks).length).toBeGreaterThan(0)
    for (const [script, program, args] of Object.values(checks)) {
      expect(scripts[script]).toBe([program, ...args].join(' '))
    }
  })
})
