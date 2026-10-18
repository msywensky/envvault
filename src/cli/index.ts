// Entry point of the envvault command (built to out/cli/envvault.mjs by
// vite.cli.config.mts). Everything testable is in main.ts.
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { main } from './main'

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

main({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  platform: process.platform,
  home: homedir(),
  env: process.env,
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  ask
}).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    process.stderr.write(
      `envvault: unexpected error (${err instanceof Error ? err.name : 'unknown'})\n`
    )
    process.exitCode = 1
  }
)
