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
  saveSettings: (settings) => invoke(CH.saveSettings, settings),
  pickFolder: (which) => invoke(CH.pickFolder, { which }),
  setGitVault: (url, confirmPrivate = false) => invoke(CH.setGitVault, { url, confirmPrivate }),
  ghStatus: () => invoke(CH.ghStatus),
  listGitRepos: () => invoke(CH.listGitRepos),
  createGitRepo: (name) => invoke(CH.createGitRepo, { name }),
  openNewRepoPage: () => invoke(CH.openNewRepoPage),
  createVault: (password, setupCode) => invoke(CH.createVault, { password, setupCode }),
  unlock: (password, setupCode) =>
    invoke(CH.unlock, setupCode === undefined ? { password } : { password, setupCode }),
  lock: () => invoke(CH.lock),
  showSetupCode: (password) => invoke(CH.showSetupCode, { password }),
  listRepos: (rescan) => invoke(CH.listRepos, { rescan }),
  // Just the two fields: a row passed as the file has others, which the schema refuses.
  previewPush: ({ repoName, path }) => invoke(CH.previewPush, { repoName, path }),
  push: (request) => invoke(CH.push, request),
  previewPull: ({ repoName, path }) => invoke(CH.previewPull, { repoName, path }),
  pull: (request) => invoke(CH.pull, request),
  pullRawDiff: (request) => invoke(CH.pullRawDiff, request),
  previewMerge: ({ repoName, path }) => invoke(CH.previewMerge, { repoName, path }),
  mergeValues: (request) => invoke(CH.mergeValues, request),
  merge: (request) => invoke(CH.merge, request),
  openEditor: ({ repoName, path }) => invoke(CH.openEditor, { repoName, path }),
  saveEdit: (request) => invoke(CH.saveEdit, request),
  removeFromVault: ({ vaultName, path, expectedVaultHash }) =>
    invoke(CH.removeFromVault, { vaultName, path, expectedVaultHash }),
  addGitignore: ({ repoName, path }) => invoke(CH.addGitignore, { repoName, path }),
  saveRepoSettings: ({ vaultName, ignored, include, exclude }) =>
    invoke(CH.saveRepoSettings, { vaultName, ignored, include, exclude }),
  setVaultName: ({ repoName, vaultName }) => invoke(CH.setVaultName, { repoName, vaultName }),
  saveDefaults: ({ include, exclude }) => invoke(CH.saveDefaults, { include, exclude }),
  resetSettings: () => invoke(CH.resetSettings),
  skillStatus: () => invoke(CH.skillStatus),
  installSkill: (replace) => invoke(CH.installSkill, { replace }),
  removeSkill: () => invoke(CH.removeSkill),
  setLayout: (layout) => invoke(CH.setLayout, layout),
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
  },
  onRepoStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, rows: RepoRow[]): void => callback(rows)
    ipcRenderer.on(EV.repoStatus, listener)
    return () => {
      ipcRenderer.removeListener(EV.repoStatus, listener)
    }
  }
}

contextBridge.exposeInMainWorld('envvault', api)
