import { dialog } from 'electron'
import { relative, resolve } from 'node:path'
import { isInside } from '../core/paths'
import { CH } from '../shared/channels'
import type { Settings, VaultLocation } from '../shared/types'
import { kickAutoPull } from './autopull'
import { setCliAccess } from './cliserver'
import { getConfig, updateConfig } from './config'
import { AppError } from './errors'
import { handle } from './ipc'
import { exclusive } from './mutex'
import * as session from './session'
import * as skill from './skill'
import * as sync from './sync'
import { configuredVault, requireVault } from './vault'
import { getMainWindow } from './window'

export function registerIpc(): void {
  handle(CH.activity, () => null)

  handle(CH.getState, async () => {
    const cfg = await getConfig()
    const vault = await configuredVault()
    return {
      configured: Boolean(cfg.projectsPath && vault),
      vault: vault ? await vault.state() : 'not-configured',
      locked: !session.isUnlocked()
    }
  })

  // Settings work while locked: they hold no secrets.
  handle(CH.getSettings, () => getConfig())
  handle(CH.saveSettings, async (patch) => {
    const next = await updateConfig(patch)
    session.setAutoLockMinutes(next.autoLockMinutes)
    if (next.autoPull) kickAutoPull()
    if (!(await setCliAccess(next.cliAccess))) {
      throw new AppError(
        'CLI_UNAVAILABLE',
        "Settings saved, but command-line access couldn't start."
      )
    }
    return next
  })
  handle(CH.pickFolder, ({ which }) => pickFolder(which))

  // Automatic pull starts once exclusive() has finished: it takes exclusive()
  // itself, which isn't re-entrant.
  handle(CH.createVault, async ({ password }) => {
    await exclusive(async () => {
      const cfg = await getConfig()
      const { key, vaultId } = await (await requireVault()).create(password)
      session.unlock(key, vaultId, cfg.autoLockMinutes)
    })
    kickAutoPull()
    return null
  })
  handle(CH.unlock, async ({ password }) => {
    await exclusive(async () => {
      const cfg = await getConfig()
      const { key, vaultId } = await (await requireVault()).open(password)
      session.unlock(key, vaultId, cfg.autoLockMinutes)
    })
    kickAutoPull()
    return null
  })
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
  // The editor: open returns env values (read-only, like the previews); save
  // writes the vault copy (like push).
  handle(CH.openEditor, ({ repoName }) => session.withKey((key) => sync.openEditor(key, repoName)))
  handle(CH.saveEdit, async (req) => {
    const result = await exclusive(() => session.withKey((key, id) => sync.saveEdit(key, id, req)))
    // Bring the edit into the local .env right away rather than within a minute.
    if (result.changed) kickAutoPull()
    return result
  })
  handle(CH.addGitignore, ({ repoName }) =>
    exclusive(() => session.withKey(() => sync.addGitignore(repoName)))
  )

  // The Claude Code skill holds no secrets, so these work while locked.
  handle(CH.skillStatus, () => skill.skillStatus())
  handle(CH.installSkill, ({ replace }) => skill.installSkill(replace))
  handle(CH.removeSkill, () => skill.removeSkill())
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
  const other = which === 'projects' ? folderOf(cfg.vault) : cfg.projectsPath
  if (other && overlaps(picked, other)) {
    throw new AppError(
      'FOLDERS_OVERLAP',
      'The projects folder and the vault folder must be separate (neither inside the other).'
    )
  }
  if (which === 'vault') return saveVault({ kind: 'folder', path: picked })
  return updateConfig({ projectsPath: picked })
}

/** Switch to another vault. Run inside exclusive(). */
async function saveVault(location: VaultLocation): Promise<Settings> {
  const cfg = await getConfig()
  if (sameLocation(cfg.vault, location)) return cfg
  // The key belongs to the old vault: wipe it now, but tell the renderer
  // only after the new location is saved, so its refresh sees the new vault.
  const wasUnlocked = session.isUnlocked()
  session.lock({ notify: false })
  try {
    return await updateConfig({ vault: location })
  } finally {
    if (wasUnlocked) session.notifyLocked()
  }
}

const folderOf = (location: VaultLocation | null): string | null =>
  location?.kind === 'folder' ? location.path : null

function sameLocation(a: VaultLocation | null, b: VaultLocation): boolean {
  if (a?.kind === 'folder' && b.kind === 'folder') return a.path === b.path
  if (a?.kind === 'git' && b.kind === 'git') return a.url === b.url && a.branch === b.branch
  return false
}

function overlaps(a: string, b: string): boolean {
  return relative(resolve(a), resolve(b)) === '' || isInside(a, b) || isInside(b, a)
}
