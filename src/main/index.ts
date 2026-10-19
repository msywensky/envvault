import { app, BrowserWindow, dialog, Menu, powerMonitor, session } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { EV } from '../shared/channels'
import { startAutoPull } from './autopull'
import { cliCommands } from './clicommands'
import { configureCli, setCliAccess, stopCliNow } from './cliserver'
import { getConfig } from './config'
import { registerIpc } from './handlers'
import { ipcHooks } from './ipc'
import { notifyPulled } from './notify'
import { devProfile } from './profile'
import * as vaultSession from './session'
import { createMainWindow, getMainWindow } from './window'

// Dev-only: ENVVAULT_PROFILE=<name> gives this run its own userData folder, so
// two "machines" can be simulated on one computer. Must run before the
// single-instance lock, which is keyed on userData.
const profile = devProfile()
if (profile) app.setPath('userData', join(app.getPath('appData'), `envvault-${profile}`))

// The fuses turn off --inspect, but not Chromium's DevTools protocol: anything
// connected to it could drive the window once you unlock, and read every value.
// Unpackaged runs keep it for development (see CLAUDE.md).
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe']

if (app.isPackaged && DEBUG_SWITCHES.some((s) => app.commandLine.hasSwitch(s))) {
  dialog.showErrorBox(
    'EnvVault',
    "EnvVault doesn't run with remote debugging turned on. Start it without --remote-debugging-port or --remote-debugging-pipe."
  )
  app.exit(1)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    // On macOS the app keeps running with no window after it is closed.
    if (!win) {
      if (app.isReady()) createMainWindow()
      return
    }
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app
    .whenReady()
    .then(() => {
      electronApp.setAppUserModelId('com.envvault.app')

      // Deny every permission request (camera, notifications, clipboard, ...).
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(false)
      )
      session.defaultSession.setPermissionCheckHandler(() => false)

      // F12 toggles DevTools in dev; Ctrl/Cmd+R reload is disabled in production.
      app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
      // Packaged, there's no View menu (DevTools, reload). macOS keeps an Edit
      // menu, without which copy and paste don't work in text fields.
      if (app.isPackaged) Menu.setApplicationMenu(packagedMenu())

      // Session lifecycle: any authorised request counts as activity; lock
      // when the machine sleeps or its screen locks, and tell the renderer.
      ipcHooks.onAuthorizedCall = vaultSession.touch
      vaultSession.onLocked(() => getMainWindow()?.webContents.send(EV.locked))
      powerMonitor.on('suspend', () => vaultSession.lock())
      powerMonitor.on('lock-screen', () => vaultSession.lock())
      startAutoPull((rows) => {
        getMainWindow()?.webContents.send(EV.autoPulled, rows)
        notifyPulled(rows)
      })

      // The envvault command. Its pushes reach the renderer like automatic
      // pulls do: as rows, so the renderer needn't call IPC.
      configureCli(
        app.getPath('userData'),
        cliCommands((row) => getMainWindow()?.webContents.send(EV.cliPushed, row))
      )
      app.on('will-quit', stopCliNow)

      registerIpc()
      createMainWindow()
      void getConfig().then((cfg) => setCliAccess(cfg.cliAccess))

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      })
    })
    .catch((err: unknown) => {
      // Name only, as in ipc.ts: error messages can quote file contents.
      console.error(`[envvault] startup failed: ${err instanceof Error ? err.name : 'unknown'}`)
      app.quit()
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

/** No menu bar on Windows; on macOS, only the app, File, Edit and Window menus. */
function packagedMenu(): Menu | null {
  if (process.platform !== 'darwin') return null
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ])
}
