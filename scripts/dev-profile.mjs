// `npm run dev` with its own settings folder, so testing never touches your
// real EnvVault settings or sync state.
//
//   npm run dev:profile                     profile "test"
//   npm run dev:profile alice               profile "alice"
//   npm run dev:profile -- alice --reset    wipe alice's settings first
//
// Each profile keeps config.json and state.json in <appData>/envvault-<name>
// (ENVVAULT_PROFILE in src/main/index.ts). Profiles can run side by side, so
// two of them can stand in for two machines sharing one vault folder.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_PROFILE = 'test'
// Must match src/main/index.ts, which silently falls back to the real
// settings folder for any other name.
const PROFILE_NAME = /^[A-Za-z0-9-]{1,20}$/

function usage(message) {
  console.error(`${message}\nUsage: npm run dev:profile -- [name] [--reset]`)
  process.exit(1)
}

/** Electron's app.getPath('appData'). */
function appDataDir() {
  if (process.platform === 'win32') {
    return process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  return process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
}

const args = process.argv.slice(2)
// Without `--`, npm keeps --reset for itself and passes it on as npm_config_reset.
const reset = args.includes('--reset') || process.env['npm_config_reset'] === 'true'
const rest = args.filter((arg) => arg !== '--reset')
const unknown = rest.find((arg) => arg.startsWith('-'))
if (unknown) usage(`Unknown option: ${unknown}`)
if (rest.length > 1) usage('Give at most one profile name.')
const profile = rest[0] ?? DEFAULT_PROFILE
if (!PROFILE_NAME.test(profile)) {
  usage(`Invalid profile name "${profile}": use 1-20 letters, digits or dashes.`)
}

const npm = process.env['npm_execpath']
if (!npm) usage('Run this through npm.')

const userData = join(appDataDir(), `envvault-${profile}`)
if (reset) {
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch (err) {
    console.error(`Could not delete ${userData} (${err.code}). Close that profile's window first.`)
    process.exit(1)
  }
  console.log(`Reset profile "${profile}".`)
}
console.log(`Profile "${profile}": settings in ${userData}`)

const env = { ...process.env, ENVVAULT_PROFILE: profile }
// Otherwise the nested npm warns about an unknown "reset" config.
delete env['npm_config_reset']
const child = spawn(process.execPath, [npm, 'run', 'dev'], { stdio: 'inherit', env })

// Ctrl+C reaches the dev server too; wait for it to shut down rather than
// exiting first and leaving it behind.
process.on('SIGINT', () => {})
child.on('error', (err) => {
  console.error(`Could not start npm (${err.code}).`)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
