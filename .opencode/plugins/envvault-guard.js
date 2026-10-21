// opencode counterpart of the Claude Code guard hook (.claude/settings.json):
// each bash call goes through `scripts/claude-hook.mjs guard`, and exit 2
// blocks it. File-tool rules live in opencode.json's permission block.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

export const EnvvaultGuard = async ({ directory }) => ({
  'tool.execute.before': async (input, output) => {
    if (input.tool !== 'bash') return
    const command = output.args?.command
    if (typeof command !== 'string') return
    const r = spawnSync('node', [join(directory, 'scripts', 'claude-hook.mjs'), 'guard'], {
      input: JSON.stringify({
        tool_name: 'Bash',
        cwd: output.args?.workdir ?? directory,
        tool_input: { command }
      }),
      encoding: 'utf8'
    })
    if (r.status === 2) throw new Error(r.stderr.trim())
  }
})
