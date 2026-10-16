import { CH } from '../shared/channels'
import { handle } from './ipc'

export function registerIpc(): void {
  handle(CH.ping, () => 'pong' as const)
}
