// Sandboxed preload: may only import 'electron' and code that gets bundled in.
// Exposes named functions only; never ipcRenderer or an IPC event object.
import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/channels'
import type { EnvVaultApi, Responses } from '../shared/api'
import type { Result } from '../shared/result'

// Ties each channel to its response type (ipcRenderer.invoke returns any).
function invoke<C extends keyof Responses>(
  channel: C,
  payload?: unknown
): Promise<Result<Responses[C]>> {
  return ipcRenderer.invoke(channel, payload)
}

const api: EnvVaultApi = {
  ping: () => invoke(CH.ping)
}

contextBridge.exposeInMainWorld('envvault', api)
