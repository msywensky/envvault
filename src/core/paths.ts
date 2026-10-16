import path from 'node:path'

export class PathEscapeError extends Error {
  constructor() {
    super('Path escapes its root folder.')
    this.name = 'PathEscapeError'
  }
}

// Starts with a letter or digit (so never ".", "..", ".git" or a hidden
// name that could collide with our ".<name>.tmp" temp files), then up to 99
// of [A-Za-z0-9._-]. Must not end in "." (Windows strips trailing dots).
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
// Device names Windows refuses as file names, with or without an extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

export function isValidRepoName(name: string): boolean {
  return NAME_RE.test(name) && !name.endsWith('.') && !WINDOWS_RESERVED.test(name)
}

/**
 * Join relative `parts` onto `root` and return the absolute result, throwing
 * if it would land on or outside `root`. Parts must use "/" separators:
 * backslashes are rejected on every platform (on POSIX they are ordinary
 * characters, on Windows separators, so allowing them would make the check
 * platform-dependent), as are segments ending in "." or " " other than "."
 * and ".." (Windows silently strips those, so "app." would open "app").
 * Symlinks are checked separately: see isInside() with fs.realpath.
 */
export function resolveInside(root: string, ...parts: string[]): string {
  for (const part of parts) {
    if (part.includes('\\') || part.includes('\0')) throw new PathEscapeError()
    for (const seg of part.split('/')) {
      if (seg !== '.' && seg !== '..' && /[. ]$/.test(seg)) throw new PathEscapeError()
    }
  }
  const base = path.resolve(root)
  const target = path.resolve(base, ...parts)
  if (!isInside(base, target)) throw new PathEscapeError()
  return target
}

/**
 * True if absolute path `target` is strictly inside `root`.
 * (path.relative compares case-insensitively on win32.)
 */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return !(rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
}
