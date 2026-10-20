// Which env files a repo syncs (FileRules): patterns over the files' paths,
// applied in main and validated and previewed with the same code in the
// renderer. Relative imports only, like the rest of src/shared.
//
// A pattern without "/" is a file name, matched in every folder: ".env.local",
// ".env.*". One with "/" is matched against the path from the repo root:
// "apps/*/.env.local". If its last part doesn't start with ".env" it names
// folders, and covers everything in them: "apps/legacy", "**/fixtures". "*"
// matches within one name, "**" any number of folders, and case is ignored,
// as it is for paths (envPathId). A file is included if an include pattern
// matches it and no exclude pattern does.

export interface FileRules {
  include: string[]
  exclude: string[]
}

/** What a repo syncs when nobody has said otherwise: every .env, in any folder. */
export const BUILT_IN_RULES: FileRules = { include: ['.env'], exclude: [] }

export const MAX_PATTERNS = 20
export const MAX_PATTERN_LENGTH = 100

// Committed templates, never real env files: .env.example, .env.local.example.
const TEMPLATE_SUFFIXES = ['example', 'sample', 'template', 'dist', 'defaults']

/**
 * Env file names that are never synced, whatever the rules say: EnvVault's
 * own backups and pull temp files (.env.bak.*), and templates.
 */
export function isReservedEnvName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower === '.env.bak' || lower.startsWith('.env.bak.')) return true
  return lower !== '.env' && TEMPLATE_SUFFIXES.includes(lower.slice(lower.lastIndexOf('.') + 1))
}

export const RESERVED_NOTE =
  'Never synced: templates (.env.example, .env.sample, .env.template, .env.dist, .env.defaults, also after another name, as in .env.local.example) and EnvVault’s own backups (.env.bak.*).'

const PATTERN_RE = /^[A-Za-z0-9._@+*/-]+$/

const isFileName = (part: string): boolean => part.toLowerCase().startsWith('.env')

/** Why `pattern` can't be used, or null. The messages never repeat it. */
export function patternProblem(pattern: string): string | null {
  if (pattern === '') return 'Enter a pattern.'
  if (pattern.length > MAX_PATTERN_LENGTH) return `Use at most ${MAX_PATTERN_LENGTH} characters.`
  if (!PATTERN_RE.test(pattern)) return 'Use letters, digits and . _ @ + - * / only.'
  const parts = pattern.split('/')
  if (parts.some((p) => p === '')) return 'Don’t start or end with /, or use //.'
  if (parts.some((p) => p === '.' || p === '..')) return 'A folder can’t be . or ..'
  if (parts.some((p) => p.includes('**') && p !== '**')) {
    return 'Use ** only as a whole folder name, as in **/fixtures.'
  }
  if (parts.length === 1 && !isFileName(pattern)) {
    return 'A file name pattern starts with .env, as in .env.local or .env.*'
  }
  return null
}

/** Why a list of patterns can't be used, or null. */
export function rulesProblem(patterns: readonly string[]): string | null {
  if (patterns.length > MAX_PATTERNS) return `Use at most ${MAX_PATTERNS} patterns.`
  for (const p of patterns) {
    const problem = patternProblem(p)
    if (problem) return problem
  }
  return null
}

const escape = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

function compile(pattern: string): RegExp {
  const parts = pattern.split('/')
  // A file name matches in any folder; folders cover everything in them.
  if (parts.length === 1) parts.unshift('**')
  else if (!isFileName(parts[parts.length - 1] ?? '')) parts.push('**')
  const source = parts
    .map((part, i) => {
      const last = i === parts.length - 1
      if (part === '**') return last ? '.*' : '(?:[^/]+/)*'
      return part.split('*').map(escape).join('[^/]*') + (last ? '' : '/')
    })
    .join('')
  return new RegExp(`^${source}$`, 'i')
}

const compiled = new Map<string, RegExp>()

/** True if `path` (from the repo root, with "/") matches `pattern` (see the top of this file). */
export function matchesPattern(path: string, pattern: string): boolean {
  let re = compiled.get(pattern)
  if (!re) {
    if (compiled.size >= 1000) compiled.clear()
    re = compile(pattern)
    compiled.set(pattern, re)
  }
  return re.test(path)
}

/** True if the rules sync the env file at `path`: an include matches, and no exclude does. */
export function isIncluded(path: string, rules: FileRules): boolean {
  return (
    rules.include.some((p) => matchesPattern(path, p)) &&
    !rules.exclude.some((p) => matchesPattern(path, p))
  )
}
