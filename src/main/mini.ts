// Mini mode: the window shrinks to one env file (the renderer's MiniView),
// kept above other windows unless the miniOnTop setting is off, so its Push
// button is at hand while you work on that repo.
//
// Main keeps that file's row fresh: when the file changes, when the window
// gains focus, and once a minute. Like automatic pull, it takes the key
// through session.withKey, which doesn't count as activity, and the row goes
// to the renderer as EV.repoStatus, which patches it in without calling IPC.
// So mini mode never keeps the vault unlocked.
import { BrowserWindow, screen } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { envFileName } from '../core/envpath'
import { placeWithin, type Rect, type Size } from '../core/layout'
import { EV } from '../shared/channels'
import { sameFile } from '../shared/envfile'
import type { EnvFile, Layout } from '../shared/types'
import { getConfig } from './config'
import { resolveEnvDir, resolveRepo } from './repos'
import * as session from './session'
import { listRepos } from './sync'
import { getMainWindow } from './window'

/** Content sizes: MiniView's two rows, and big enough for the push or pull dialog. */
const MINI: Size = { width: 420, height: 101 }
const REVIEW: Size = { width: 600, height: 640 }
/** Window sizes, title bar included. */
const MINI_MIN: Size = { width: 340, height: 120 }
/** The full window's minimum, as in createMainWindow. */
const FULL_MIN: Size = { width: 720, height: 480 }
const RECHECK_MS = 60_000
const FULL_SCREEN_EXIT_MS = 1500
const DEBOUNCE_MS = 300

interface Mini {
  win: BrowserWindow
  file: EnvFile
  /** Where the full window was, to go back to. */
  fullBounds: Rect
  wasMaximized: boolean
  watcher: FSWatcher | null
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
  const file = { repoName: layout.repoName, path: layout.path }
  if (current?.win !== win) await enter(win, file)
  else if (!isFile(current.file, file)) {
    current.file = file
    await watchFile(current)
  }
  resize(win, layout.reviewing ? REVIEW : MINI)
  win.setAlwaysOnTop((await getConfig()).miniOnTop, 'floating')
  recheck()
  return null
}

/** Apply the miniOnTop setting now, if the window is in mini mode. */
export function applyMiniOnTop(onTop: boolean): void {
  if (mini && !mini.win.isDestroyed()) mini.win.setAlwaysOnTop(onTop, 'floating')
}

/** True if `a` and `b` are the same env file (see sameFile). */
const isFile = (a: EnvFile, b: EnvFile): boolean =>
  sameFile(
    { name: a.repoName, path: a.path, storedName: null },
    { name: b.repoName, path: b.path, storedName: null }
  )

async function enter(win: BrowserWindow, file: EnvFile): Promise<void> {
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
  const wasMaximized = win.isMaximized()
  const fullBounds = win.getNormalBounds()
  if (wasMaximized) win.unmaximize()
  win.setMinimumSize(MINI_MIN.width, MINI_MIN.height)
  const onFocus = (): void => recheck()
  const onClosed = (): void => stop()
  win.on('focus', onFocus)
  win.once('closed', onClosed)
  mini = {
    win,
    file,
    fullBounds,
    wasMaximized,
    watcher: null,
    timer: setInterval(recheck, RECHECK_MS),
    onFocus,
    onClosed
  }
  mini.timer.unref()
  await watchFile(mini)
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
  if (current.wasMaximized) win.maximize()
}

function stop(): void {
  if (!mini) return
  clearInterval(mini.timer)
  mini.watcher?.close()
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
 * Watch the env file's folder for it (editors save by renaming over it, and
 * it may not exist yet). Without a watcher, focus and the timer still recheck.
 */
async function watchFile(current: Mini): Promise<void> {
  current.watcher?.close()
  current.watcher = null
  const file = current.file
  let dir: string | null
  try {
    const { projectsPath } = await getConfig()
    if (!projectsPath) return
    dir = await resolveEnvDir(await resolveRepo(projectsPath, file.repoName), file.path)
  } catch {
    return
  }
  // Left mini mode or switched file while resolving.
  if (!dir || mini !== current || current.file !== file) return
  const name = envFileName(file.path)
  try {
    current.watcher = watch(dir, { persistent: false }, (_event, changed) => {
      if (changed === null || changed === name) schedule()
    })
    current.watcher.on('error', () => {
      current.watcher?.close()
      current.watcher = null
    })
  } catch {
    current.watcher = null
  }
}

function schedule(): void {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    recheck()
  }, DEBOUNCE_MS)
}

/** Recompute the file's row and send it; one at a time, rerun if asked meanwhile. */
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
        await sendRow()
      } while (again)
    } finally {
      checking = false
    }
  })()
}

async function sendRow(): Promise<void> {
  const current = mini
  if (!current || !session.isUnlocked()) return
  const file = current.file
  try {
    const rows = await session.withKey((key, id) => listRepos(key, id, { only: file.repoName }))
    // The repo's rows: one per env file. Never just the first.
    const row = rows.find((r) =>
      sameFile(r, { name: file.repoName, path: file.path, storedName: null })
    )
    if (row && mini === current && current.file === file && !current.win.isDestroyed()) {
      current.win.webContents.send(EV.repoStatus, row)
    }
  } catch {
    // Locked, not configured or unreadable: the next recheck tries again.
  }
}
