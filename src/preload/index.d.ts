import type { EnvVaultApi } from '../shared/api'

declare global {
  interface Window {
    envvault: EnvVaultApi
  }
}

export {}
