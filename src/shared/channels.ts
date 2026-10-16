// IPC channel names. Kept free of runtime dependencies so the sandboxed
// preload can import it without bundling zod.

export const CH = {
  ping: 'app:ping',
  getState: 'app:getState',
  activity: 'app:activity',
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  pickFolder: 'settings:pickFolder',
  createVault: 'session:createVault',
  unlock: 'session:unlock',
  lock: 'session:lock',
  listRepos: 'repos:list',
  previewPush: 'repo:previewPush',
  push: 'repo:push',
  previewPull: 'repo:previewPull',
  pull: 'repo:pull',
  addGitignore: 'repo:addGitignore'
} as const

export type Channel = (typeof CH)[keyof typeof CH]

// Events pushed from main to the renderer.
export const EV = {
  locked: 'session:locked'
} as const
