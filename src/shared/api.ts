import type { Result } from './result'

// Response payload for each channel. main's `handle()` and the preload's
// `invoke()` are both typed against this map.
export interface Responses {
  'app:ping': 'pong'
}

// The API the preload exposes as `window.envvault`. Type-only.
export interface EnvVaultApi {
  ping(): Promise<Result<Responses['app:ping']>>
}
