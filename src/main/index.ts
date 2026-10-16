import { app, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './handlers'
import { createMainWindow, getMainWindow } from './window'

// Dev-only: ENVVAULT_PROFILE=<name> gives this run its own userData folder, so
// two "machines" can be simulated on one computer. Must run before the
// single-instance lock, which is keyed on userData.
const profile = process.env['ENVVAULT_PROFILE']
if (is.dev && profile && /^[A-Za-z0-9-]{1,20}$/.test(profile)) {
  app.setPath('userData', join(app.getPath('appData'), `envvault-${profile}`))
}

if (!app.requestSingleInstanceLock()) {
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

      registerIpc()
      createMainWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      })
    })
    .catch((err: unknown) => {
      console.error('[envvault] startup failed', err)
      app.quit()
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
