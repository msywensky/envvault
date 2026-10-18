// Tells the user about things that happen while EnvVault isn't in front.
// macOS delivers system notifications only for code-signed apps: dev runs and
// the unsigned build get a 'failed' event (UNErrorDomain error 1). When a
// notification can't be shown, fall back to a Dock badge with one bounce
// (macOS) or a flashing taskbar button (Windows), cleared on focus.
import { app, Notification } from 'electron'
import { autoPullMessage } from '../shared/messages'
import type { RepoRow } from '../shared/types'
import { getMainWindow } from './window'

// Held so the notification isn't garbage-collected before it is clicked.
let current: Notification | null = null
/** Repos pulled since the window was last focused, shown on the Dock badge. */
let unseen = 0

function clearAttention(): void {
  unseen = 0
  app.dock?.setBadge('')
  getMainWindow()?.flashFrame(false)
}

/** The fallback: badge and bounce the Dock icon, or flash the taskbar button. */
function requestAttention(count: number): void {
  const win = getMainWindow()
  if (!win || win.isFocused()) return
  if (unseen === 0) win.once('focus', clearAttention)
  unseen += count
  if (app.dock) {
    app.dock.setBadge(String(unseen))
    app.dock.bounce('informational')
  } else {
    win.flashFrame(true)
  }
}

/** Tell the user about automatic pulls, unless EnvVault is the focused window. */
export function notifyPulled(rows: RepoRow[]): void {
  const win = getMainWindow()
  if (!win || win.isFocused()) return
  if (!Notification.isSupported()) {
    requestAttention(rows.length)
    return
  }
  current?.close()
  current = new Notification({ title: 'EnvVault', body: autoPullMessage(rows), silent: true })
  current.on('failed', () => requestAttention(rows.length))
  current.on('click', () => {
    const w = getMainWindow()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })
  current.show()
}
