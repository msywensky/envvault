// Compares a .env with the repo's .env.example: keys either side lacks, and
// secret-looking values copied into the example, which git usually tracks.
// Returns key names only. looksSecret is a heuristic tuned to stay quiet for
// values that are commonly the same in both files, such as localhost URLs
// and ports.
import type { ExampleDiff } from '../shared/types'

/** Values of keys with these prefixes ship to the browser, so they aren't secret. */
const PUBLIC_PREFIXES = ['VITE_', 'NEXT_PUBLIC_', 'PUBLIC_', 'REACT_APP_', 'EXPO_PUBLIC_']

/** Parts of a key name (split on `_`, `.` and `-`) that say it holds a secret. */
const SECRET_PARTS = new Set([
  'SECRET',
  'SECRETS',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'PASS',
  'PWD',
  'KEY',
  'APIKEY',
  'PRIVATE',
  'CREDENTIAL',
  'CREDENTIALS',
  'SALT',
  'DSN'
])

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'host.docker.internal'])
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i
const PATH_RE = /^(\/|~\/|\.{1,2}\/|[A-Za-z]:[\\/])/

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return LOCAL_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.localhost')
}

/** `value` parsed as a URL, or null if it isn't one. */
function asUrl(value: string): URL | null {
  if (!URL_RE.test(value)) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** Long, no spaces, letters and digits, varied, and not a file path. */
function looksLikeToken(value: string): boolean {
  return (
    value.length >= 16 &&
    !/\s/.test(value) &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value) &&
    new Set(value).size >= 10 &&
    !PATH_RE.test(value)
  )
}

/**
 * True if a value that is the same in .env and .env.example is probably a
 * secret worth warning about: a URL with a password for a non-local host, a
 * value of 8+ characters under a secret-sounding key name, or a token-like
 * value. Empty values and browser-public keys never are.
 */
export function looksSecret(key: string, value: string): boolean {
  const upper = key.toUpperCase()
  if (value === '' || PUBLIC_PREFIXES.some((p) => upper.startsWith(p))) return false
  // A URL is judged only by its password, so API_TOKEN_URL=https://... is fine.
  const url = asUrl(value)
  if (url) return url.password !== '' && !isLocalHost(url.hostname)
  if (value.length >= 8 && upper.split(/[_.-]/).some((part) => SECRET_PARTS.has(part))) return true
  return looksLikeToken(value)
}

/** Compare parsed .env and .env.example contents (see parseEnv). Sorted key names. */
export function compareExample(
  env: Map<string, string>,
  example: Map<string, string>
): ExampleDiff {
  const sameValue: string[] = []
  const missing: string[] = []
  for (const [key, value] of example) {
    if (!env.has(key)) missing.push(key)
    else if (env.get(key) === value && looksSecret(key, value)) sameValue.push(key)
  }
  const undocumented = [...env.keys()].filter((key) => !example.has(key))
  return { sameValue: sameValue.sort(), missing: missing.sort(), undocumented: undocumented.sort() }
}
