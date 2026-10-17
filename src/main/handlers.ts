import { dialog } from 'electron'
import { relative, resolve } from 'node:path'
import { isInside } from '../core/paths'
import { CH } from '../shared/channels'
import type { Settings } from '../shared/types'
import { getConfig, updateConfig } from './config'
import { AppError } from './errors'
import { handle } from './ipc'
import { exclusive } from './mutex'
import * as session from './session'
import * as sync from './sync'
import { createVault, folderState, openVault } from './vault'
import { getMainWindow } from './window'

export function registerIpc(): void {
  handle(CH.activity, () => null)

  handle(CH.getState, async () => {
    const cfg = await getConfig()
    return {
      configured: Boolean(cfg.projectsPath && cfg.vaultPath),
      vault: await folderState(cfg.vaultPath),
      locked: !session.isUnlocked()
    }
  })

  // Settings work while locked: they hold no secrets.
  handle(CH.getSettings, () => getConfig())
  handle(CH.saveSettings, async (patch) => {
    const next = await updateConfig(patch)
    session.setAutoLockMinutes(next.autoLockMinutes)
    return next
  })
  handle(CH.pickFolder, ({ which }) => pickFolder(which))

  handle(CH.createVault, ({ password }) =>
    exclusive(async () => {
      const cfg = await getConfig()
      if (!cfg.vaultPath) throw new AppError('NOT_CONFIGURED', 'Choose a vault folder first.')
      const { key, vaultId } = await createVault(cfg.vaultPath, password)
      session.unlock(key, vaultId, cfg.autoLockMinutes)
      return null
    })
  )
  handle(CH.unlock, ({ password }) =>
    exclusive(async () => {
      const cfg = await getConfig()
      if (!cfg.vaultPath) throw new AppError('NOT_CONFIGURED', 'Choose a vault folder first.')
      const { key, vaultId } = await openVault(cfg.vaultPath, password)
      session.unlock(key, vaultId, cfg.autoLockMinutes)
      return null
    })
  )
  handle(CH.lock, () => {
    session.lock()
    return null
  })

  // Everything below needs the key. Paths come only from config; the
  // renderer supplies validated repo names and flags. Writes take the key
  // *inside* exclusive(), so an operation queued behind a lock or a vault
  // switch fails with LOCKED instead of running with a stale key.
  handle(CH.listRepos, () => session.withKey((key, id) => sync.listRepos(key, id)))
  handle(CH.previewPush, ({ repoName }) =>
    session.withKey((key, id) => sync.previewPush(key, id, repoName))
  )
  handle(CH.push, (req) => exclusive(() => session.withKey((key, id) => sync.push(key, id, req))))
  handle(CH.previewPull, ({ repoName }) =>
    session.withKey((key, id) => sync.previewPull(key, id, repoName))
  )
  handle(CH.pull, (req) => exclusive(() => session.withKey((key, id) => sync.pull(key, id, req))))
  // Read-only like the previews. Returns env values when asked (see sync.pullRawDiff).
  handle(CH.pullRawDiff, (req) => session.withKey((key) => sync.pullRawDiff(key, req)))
  handle(CH.addGitignore, ({ repoName }) =>
    exclusive(() => session.withKey(() => sync.addGitignore(repoName)))
  )
}

async function pickFolder(which: 'projects' | 'vault'): Promise<Settings | null> {
  const win = getMainWindow()
  const options: Electron.OpenDialogOptions = {
    title: which === 'projects' ? 'Choose your projects folder' : 'Choose the vault folder',
    properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
  }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  const picked = result.filePaths[0]
  if (result.canceled || !picked) return null
  // The dialog stays outside the queue (it can be open for minutes); the
  // check-and-save runs inside it.
  return exclusive(() => saveFolder(which, picked))
}

async function saveFolder(which: 'projects' | 'vault', picked: string): Promise<Settings> {
  const cfg = await getConfig()
  const other = which === 'projects' ? cfg.vaultPath : cfg.projectsPath
  if (other && overlaps(picked, other)) {
    throw new AppError(
      'FOLDERS_OVERLAP',
      'The projects folder and the vault folder must be separate (neither inside the other).'
    )
  }
  if (which === 'vault') {
    if (cfg.vaultPath === picked) return cfg
    // The key belongs to the old vault: wipe it now, but tell the renderer
    // only after the new path is saved, so its refresh sees the new folder.
    const wasUnlocked = session.isUnlocked()
    session.lock({ notify: false })
    try {
      return await updateConfig({ vaultPath: picked })
    } finally {
      if (wasUnlocked) session.notifyLocked()
    }
  }
  return updateConfig({ projectsPath: picked })
}

function overlaps(a: string, b: string): boolean {
  return relative(resolve(a), resolve(b)) === '' || isInside(a, b) || isInside(b, a)
}
