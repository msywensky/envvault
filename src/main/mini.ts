// Mini mode: the window shrinks to one env file, or to all of a repo's env
// files (the renderer's MiniView), kept above other windows unless the
// miniOnTop setting is off, so their Push buttons are at hand while you work
// on that repo.
//
// Main keeps their rows fresh: when a file changes, when the window gains
// focus, and once a minute. Like automatic pull, it takes the key through
// session.withKey, which doesn't count as activity, and the rows go to the
// renderer as EV.repoStatus, which patches them in without calling IPC.
// So mini mode never keeps the vault unlocked.
import { BrowserWindow, screen } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { envFileName } from '../core/envpath'
import { placeWithin, type Rect, type Size } from '../core/layout'
import { EV } from '../shared/channels'
import type { Layout } from '../shared/types'
import { getConfig } from './config'
import { resolveEnvDir, resolveRepo } from './repos'
import * as session from './session'
import { listRepos } from './sync'
import { getMainWindow } from './window'

/** MiniView's header and one message or unlock row, in content pixels. */
const HEADER = 45
const MESSAGE = 56
/** One env file's row in a repo's list, and how many are shown before it scrolls. */
const FILE_ROW = 40
const MAX_ROWS = 3
/** Content sizes: the header alone, the header plus a message, and the review dialog. */
const ONE_ROW: Size = { width: 540, height: HEADER }
const TWO_ROWS: Size = { width: 540, height: HEADER + MESSAGE }
const REVIEW: Size = { width: 600, height: 640 }
/** Window sizes, title bar included. */
const MINI_MIN: Size = { width: 540, height: 80 }
/** The full window's minimum, as in createMainWindow. */
const FULL_MIN: Size = { width: 720, height: 480 }
const RECHECK_MS = 60_000
const FULL_SCREEN_EXIT_MS = 1500
const DEBOUNCE_MS = 300

interface Mini {
  win: BrowserWindow
  repoName: string
  paths: string[]
  /** Where the full window was, to go back to. */
  fullBounds: Rect
  watchers: FSWatcher[]
  timer: NodeJS.Timeout
  onFocus: () => void
  onClosed: () => void
}

let mini: Mini | null = null
let debounce: NodeJS.Timeout | null = null
let checking = false
let again = false

export async function setLayout(layout: Layout): Promise<null> {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return null
  if (layout.layout === 'full') {
    leave()
    return null
  }
  const current = mini
  const target = { repoName: layout.repoName, paths: layout.paths }
  if (current?.win !== win) await enter(win, target)
  else if (!sameTarget(current, target)) {
    current.repoName = target.repoName
    current.paths = [...target.paths]
    await watchFiles(current)
  }
  resize(win, sizeFor(layout))
  win.setAlwaysOnTop((await getConfig()).miniOnTop, 'floating')
  recheck()
  return null
}

/** Apply the miniOnTop setting now, if the window is in mini mode. */
export function applyMiniOnTop(onTop: boolean): void {
  if (mini && !mini.win.isDestroyed()) mini.win.setAlwaysOnTop(onTop, 'floating')
}

/** The content size for a mini request: the header, one message row, or a file row each. */
function sizeFor(layout: Extract<Layout, { layout: 'mini' }>): Size {
  if (layout.reviewing) return REVIEW
  if (layout.paths.length === 1) return layout.compact ? ONE_ROW : TWO_ROWS
  // Locked, the unlock form replaces the file rows.
  if (!session.isUnlocked()) return TWO_ROWS
  const rows = Math.min(layout.paths.length, MAX_ROWS)
  return { width: ONE_ROW.width, height: HEADER + rows * FILE_ROW }
}

interface Target {
  repoName: string
  paths: string[]
}

/** True if `a` and `b` show the same repo's files (paths compared as the vault does). */
const sameTarget = (a: Target, b: Target): boolean =>
  a.repoName.toLowerCase() === b.repoName.toLowerCase() &&
  a.paths.length === b.paths.length &&
  a.paths.every((path, i) => path.toLowerCase() === b.paths[i]?.toLowerCase())

async function enter(win: BrowserWindow, target: Target): Promise<void> {
  leave()
  if (win.isFullScreen()) {
    // macOS animates out of full screen; resizing before it ends is ignored.
    const left = new Promise<void>((resolve) => {
      win.once('leave-full-screen', () => resolve())
      setTimeout(resolve, FULL_SCREEN_EXIT_MS)
    })
    win.setFullScreen(false)
    await left
  }
  const fullBounds = win.getNormalBounds()
  win.setMinimumSize(MINI_MIN.width, MINI_MIN.height)
  const onFocus = (): void => recheck()
  const onClosed = (): void => stop()
  win.on('focus', onFocus)
  win.once('closed', onClosed)
  mini = {
    win,
    repoName: target.repoName,
    paths: [...target.paths],
    fullBounds,
    watchers: [],
    timer: setInterval(recheck, RECHECK_MS),
    onFocus,
    onClosed
  }
  mini.timer.unref()
  await watchFiles(mini)
}

/** Back to the full window, where it was. */
function leave(): void {
  const current = mini
  if (!current) return
  stop()
  const { win } = current
  if (win.isDestroyed()) return
  win.removeListener('focus', current.onFocus)
  win.removeListener('closed', current.onClosed)
  win.setAlwaysOnTop(false)
  win.setMinimumSize(FULL_MIN.width, FULL_MIN.height)
  win.setBounds(current.fullBounds)
}

function stop(): void {
  if (!mini) return
  clearInterval(mini.timer)
  for (const watcher of mini.watchers) watcher.close()
  mini.watchers = []
  if (debounce) clearTimeout(debounce)
  debounce = null
  mini = null
}

/** Resize the content to `size`, inside the display the window is on. */
function resize(win: BrowserWindow, size: Size): void {
  const bounds = win.getBounds()
  const content = win.getContentBounds()
  const frame = { width: bounds.width - content.width, height: bounds.height - content.height }
  const area = screen.getDisplayMatching(bounds).workArea
  win.setBounds(
    placeWithin(
      bounds,
      { width: size.width + frame.width, height: size.height + frame.height },
      area
    )
  )
}

/**
 * Watch the folders of the target's env files (editors save by renaming over
 * them, and they may not exist yet). Without a watcher, focus and the timer
 * still recheck.
 */
async function watchFiles(current: Mini): Promise<void> {
  for (const watcher of current.watchers) watcher.close()
  current.watchers = []
  const target: Target = { repoName: current.repoName, paths: [...current.paths] }
  const byDir = new Map<string, Set<string>>()
  try {
    const { projectsPath } = await getConfig()
    if (!projectsPath) return
    const repoDir = await resolveRepo(projectsPath, target.repoName)
    for (const path of target.paths) {
      try {
        const dir = await resolveEnvDir(repoDir, path)
        if (!dir) continue
        const names = byDir.get(dir)
        if (names) names.add(envFileName(path))
        else byDir.set(dir, new Set([envFileName(path)]))
      } catch {
        // A missing or symlinked folder has no watcher; the timer still rechecks.
      }
    }
  } catch {
    return
  }
  // Left mini mode or switched target while resolving.
  if (mini !== current || !sameTarget(current, target)) return
  for (const [dir, names] of byDir) {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, changed) => {
        if (changed === null || names.has(changed)) schedule()
      })
      watcher.on('error', () => {
        watcher.close()
        current.watchers = current.watchers.filter((w) => w !== watcher)
      })
      current.watchers.push(watcher)
    } catch {
      // fs.watch can fail (permissions, a folder that just went away).
    }
  }
}

function schedule(): void {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    recheck()
  }, DEBOUNCE_MS)
}

/** Recompute the target's rows and send them; one at a time, rerun if asked meanwhile. */
function recheck(): void {
  if (checking) {
    again = true
    return
  }
  checking = true
  void (async () => {
    try {
      do {
        again = false
        await sendRows()
      } while (again)
    } finally {
      checking = false
    }
  })()
}

async function sendRows(): Promise<void> {
  const current = mini
  if (!current || !session.isUnlocked()) return
  const target: Target = { repoName: current.repoName, paths: [...current.paths] }
  const wanted = new Set(target.paths.map((path) => path.toLowerCase()))
  try {
    const { rows } = await session.withKey((key, id) =>
      listRepos(key, id, { only: target.repoName })
    )
    const found = rows.filter(
      (row) => row.local && row.path !== null && wanted.has(row.path.toLowerCase())
    )
    if (
      found.length &&
      mini === current &&
      sameTarget(current, target) &&
      !current.win.isDestroyed()
    ) {
      current.win.webContents.send(EV.repoStatus, found)
    }
  } catch {
    // Locked, not configured or unreadable: the next recheck tries again.
  }
}
