import { dialog, shell } from 'electron'
import { relative, resolve } from 'node:path'
import { isInside } from '../core/paths'
import { CH } from '../shared/channels'
import type { Settings, VaultLocation } from '../shared/types'
import { kickAutoPull } from './autopull'
import { setCliAccess } from './cliserver'
import { autoLockAfter, getConfig, updateConfig } from './config'
import { AppError } from './errors'
import { handle } from './ipc'
import { exclusive } from './mutex'
import * as session from './session'
import * as skill from './skill'
import * as gh from './gh'
import { prepareGitVault } from './gitvault'
import { applyMiniOnTop, setLayout } from './mini'
import * as sync from './sync'
import { configuredVault, requireVault } from './vault'
import { getMainWindow } from './window'

export function registerIpc(): void {
  handle(CH.activity, () => null)

  handle(CH.getState, async () => {
    const cfg = await getConfig()
    const vault = await configuredVault()
    const state = vault ? await vault.state() : 'not-configured'
    // Unlocking reports a meta.json it can't read; the lock screen just needs to know.
    const setupCode =
      vault && state === 'ready' ? await vault.setupCodeState().catch(() => null) : null
    return {
      configured: Boolean(cfg.projectsPath && vault),
      vault: state,
      setupCode,
      locked: !session.isUnlocked()
    }
  })

  // Settings work while locked: they hold no secrets.
  handle(CH.getSettings, () => getConfig())
  handle(CH.saveSettings, async (patch) => {
    const next = await updateConfig(patch)
    session.setAutoLockMinutes(autoLockAfter(next))
    applyMiniOnTop(next.miniOnTop)
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
  // Works while locked: mini mode shows a compact lock screen.
  handle(CH.setLayout, (layout) => setLayout(layout))
  // Like the folder picker: the checks (network) run outside the queue, the
  // save inside it.
  handle(CH.setGitVault, async ({ url, confirmPrivate }) => {
    const location = await prepareGitVault(url, confirmPrivate)
    return exclusive(() => saveVault(location))
  })
  handle(CH.ghStatus, () => gh.ghStatus())
  handle(CH.listGitRepos, () => gh.listPrivateRepos())
  handle(CH.createGitRepo, async ({ name }) => {
    const location = await prepareGitVault(await gh.createPrivateRepo(name))
    return exclusive(() => saveVault(location))
  })
  // A fixed URL: the renderer never names one to open.
  handle(CH.openNewRepoPage, async () => {
    await shell.openExternal(gh.NEW_REPO_PAGE)
    return null
  })

  // Automatic pull starts once exclusive() has finished: it takes exclusive()
  // itself, which isn't re-entrant.
  handle(CH.createVault, async ({ password, setupCode }) => {
    const created = await exclusive(async () => {
      const cfg = await getConfig()
      const vault = await (await requireVault()).create(password, { setupCode })
      session.unlock(vault.key, vault.vaultId, autoLockAfter(cfg))
      return vault
    })
    kickAutoPull()
    // The setup code crosses IPC here once, to be shown and saved by the user.
    return { setupCode: created.setupCode }
  })
  handle(CH.unlock, async ({ password, setupCode }) => {
    await exclusive(async () => {
      const cfg = await getConfig()
      const { key, vaultId } = await (await requireVault()).open(password, setupCode)
      session.unlock(key, vaultId, autoLockAfter(cfg))
    })
    kickAutoPull()
    return null
  })
  // Read-only, but only while unlocked, and only with the password again.
  handle(CH.showSetupCode, ({ password }) =>
    session.withKey(async () => ({
      setupCode: await (await requireVault()).showSetupCode(password)
    }))
  )
  handle(CH.lock, () => {
    session.lock()
    return null
  })

  // Everything below needs the key. Paths come only from config; the
  // renderer supplies validated repo names and flags. Writes take the key
  // *inside* exclusive(), so an operation queued behind a lock or a vault
  // switch fails with LOCKED instead of running with a stale key.
  handle(CH.listRepos, ({ rescan }) =>
    session.withKey((key, id) => sync.listRepos(key, id, { find: rescan }))
  )
  handle(CH.previewPush, (file) => session.withKey((key, id) => sync.previewPush(key, id, file)))
  handle(CH.push, (req) => exclusive(() => session.withKey((key, id) => sync.push(key, id, req))))
  handle(CH.previewPull, (file) => session.withKey((key, id) => sync.previewPull(key, id, file)))
  handle(CH.pull, (req) => exclusive(() => session.withKey((key, id) => sync.pull(key, id, req))))
  // Read-only like the previews. Returns env values when asked (see sync.pullRawDiff).
  handle(CH.pullRawDiff, (req) => session.withKey((key) => sync.pullRawDiff(key, req)))
  // Resolving a conflict: the preview and values are read-only like the
  // previews (values only when asked, see sync.mergeValues); merge writes both
  // sides, like a push and a pull.
  handle(CH.previewMerge, (file) => session.withKey((key, id) => sync.previewMerge(key, id, file)))
  handle(CH.mergeValues, (req) => session.withKey((key) => sync.mergeValues(key, req)))
  handle(CH.merge, (req) => exclusive(() => session.withKey((key, id) => sync.merge(key, id, req))))
  // The editor: open returns env values (read-only, like the previews); save
  // writes the vault copy (like push).
  handle(CH.openEditor, (file) => session.withKey((key) => sync.openEditor(key, file)))
  handle(CH.saveEdit, async (req) => {
    const result = await exclusive(() => session.withKey((key, id) => sync.saveEdit(key, id, req)))
    // Bring the edit into the local .env right away rather than within a minute.
    if (result.changed) kickAutoPull()
    return result
  })
  handle(CH.removeFromVault, (req) =>
    exclusive(() => session.withKey((key, id) => sync.removeFromVault(key, id, req)))
  )
  handle(CH.addGitignore, (file) =>
    exclusive(() => session.withKey((key) => sync.addGitignore(key, file)))
  )
  // Settings can bring files into sync (a repo no longer ignored, a new
  // include), so automatic pull runs once they are saved.
  handle(CH.saveRepoSettings, async (req) => {
    await exclusive(() => session.withKey((key) => sync.saveRepoSettings(key, req)))
    kickAutoPull()
    return null
  })
  handle(CH.saveDefaults, async (rules) => {
    await exclusive(() => session.withKey((key) => sync.saveDefaults(key, rules)))
    kickAutoPull()
    return null
  })
  handle(CH.resetSettings, () => exclusive(() => session.withKey((key) => sync.resetSettings(key))))
  // This machine's config only, but it changes what a folder syncs with:
  // unlocked only, and never in the middle of a push or pull.
  handle(CH.setVaultName, async (req) => {
    await exclusive(() => session.withKey(() => sync.setVaultName(req)))
    kickAutoPull()
    return null
  })

  // Only picks: the file joins the repo's settings when they are saved.
  // Unlocked only. Like pickFolder, the dialog stays outside the queue and
  // holds no key while it is open.
  handle(CH.pickRepoFile, async ({ repoName }) => {
    const dir = await session.withKey(() => sync.repoFolder(repoName))
    const win = getMainWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose an env file to sync',
      defaultPath: dir,
      properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent']
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const picked = result.filePaths[0]
    if (result.canceled || !picked) return null
    return { path: await session.withKey(() => sync.pickedPath(repoName, picked)) }
  })

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
  if (a?.kind === 'git' && b.kind === 'git') {
    return a.url === b.url && a.branch === b.branch && a.privateConfirmed === b.privateConfirmed
  }
  return false
}

function overlaps(a: string, b: string): boolean {
  return relative(resolve(a), resolve(b)) === '' || isInside(a, b) || isInside(b, a)
}
