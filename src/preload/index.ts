// Sandboxed preload: may only import 'electron' and code that gets bundled in.
// Exposes named functions only; never ipcRenderer or an IPC event object.
import { contextBridge, ipcRenderer } from 'electron'
import { CH, EV } from '../shared/channels'
import type { EnvVaultApi, Responses } from '../shared/api'
import type { Result } from '../shared/result'
import type { RepoRow } from '../shared/types'

// Ties each channel to its response type (ipcRenderer.invoke returns any).
function invoke<C extends keyof Responses>(
  channel: C,
  payload?: unknown
): Promise<Result<Responses[C]>> {
  return ipcRenderer.invoke(channel, payload)
}

const api: EnvVaultApi = {
  getState: () => invoke(CH.getState),
  activity: () => invoke(CH.activity),
  getSettings: () => invoke(CH.getSettings),
  saveSettings: (patch) => invoke(CH.saveSettings, patch),
  pickFolder: (which) => invoke(CH.pickFolder, { which }),
  setGitVault: (url) => invoke(CH.setGitVault, { url }),
  ghStatus: () => invoke(CH.ghStatus),
  listGitRepos: () => invoke(CH.listGitRepos),
  createGitRepo: (name) => invoke(CH.createGitRepo, { name }),
  openNewRepoPage: () => invoke(CH.openNewRepoPage),
  createVault: (password) => invoke(CH.createVault, { password }),
  unlock: (password) => invoke(CH.unlock, { password }),
  lock: () => invoke(CH.lock),
  listRepos: () => invoke(CH.listRepos),
  previewPush: (repoName) => invoke(CH.previewPush, { repoName }),
  push: (request) => invoke(CH.push, request),
  previewPull: (repoName) => invoke(CH.previewPull, { repoName }),
  pull: (request) => invoke(CH.pull, request),
  pullRawDiff: (request) => invoke(CH.pullRawDiff, request),
  openEditor: (repoName) => invoke(CH.openEditor, { repoName }),
  saveEdit: (request) => invoke(CH.saveEdit, request),
  addGitignore: (repoName) => invoke(CH.addGitignore, { repoName }),
  skillStatus: () => invoke(CH.skillStatus),
  installSkill: (replace) => invoke(CH.installSkill, { replace }),
  removeSkill: () => invoke(CH.removeSkill),
  onLocked: (callback) => {
    // Never hand the IPC event to the page: event.sender is ipcRenderer.
    const listener = (): void => callback()
    ipcRenderer.on(EV.locked, listener)
    return () => {
      ipcRenderer.removeListener(EV.locked, listener)
    }
  },
  onAutoPulled: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, rows: RepoRow[]): void => callback(rows)
    ipcRenderer.on(EV.autoPulled, listener)
    return () => {
      ipcRenderer.removeListener(EV.autoPulled, listener)
    }
  },
  onCliPushed: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, row: RepoRow): void => callback(row)
    ipcRenderer.on(EV.cliPushed, listener)
    return () => {
      ipcRenderer.removeListener(EV.cliPushed, listener)
    }
  }
}

contextBridge.exposeInMainWorld('envvault', api)
