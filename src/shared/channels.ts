// IPC channel names. Kept free of runtime dependencies so the sandboxed
// preload can import it without bundling zod.

export const CH = {
  getState: 'app:getState',
  activity: 'app:activity',
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  pickFolder: 'settings:pickFolder',
  setGitVault: 'settings:setGitVault',
  ghStatus: 'git:ghStatus',
  listGitRepos: 'git:listRepos',
  createGitRepo: 'git:createRepo',
  openNewRepoPage: 'git:openNewRepoPage',
  createVault: 'session:createVault',
  unlock: 'session:unlock',
  lock: 'session:lock',
  showSetupCode: 'vault:showSetupCode',
  listRepos: 'repos:list',
  previewPush: 'repo:previewPush',
  push: 'repo:push',
  previewPull: 'repo:previewPull',
  pull: 'repo:pull',
  pullRawDiff: 'repo:pullRawDiff',
  previewMerge: 'repo:previewMerge',
  mergeValues: 'repo:mergeValues',
  merge: 'repo:merge',
  openEditor: 'repo:openEditor',
  saveEdit: 'repo:saveEdit',
  removeFromVault: 'repo:removeFromVault',
  addGitignore: 'repo:addGitignore',
  saveRepoSettings: 'repo:saveSettings',
  setVaultName: 'repo:setVaultName',
  pickRepoFile: 'repo:pickFile',
  saveDefaults: 'vault:saveDefaults',
  resetSettings: 'vault:resetSettings',
  skillStatus: 'skill:status',
  installSkill: 'skill:install',
  removeSkill: 'skill:remove',
  setLayout: 'window:setLayout'
} as const

export type Channel = (typeof CH)[keyof typeof CH]

// Events pushed from main to the renderer.
export const EV = {
  locked: 'session:locked',
  /** Rows (metadata only) that automatic pull just pulled. */
  autoPulled: 'repos:autoPulled',
  /** The row (metadata only) the envvault command just pushed. */
  cliPushed: 'repos:cliPushed',
  /** Mini mode's env file (metadata only), rechecked in the background. */
  repoStatus: 'repos:status'
} as const
