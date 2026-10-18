// Where the app listens for the envvault command, and where it keeps the
// token the command must send. The app and the command both compute it from
// the app's userData folder, so each user and dev profile gets its own.
import { createHash } from 'node:crypto'
import path from 'node:path'

export interface CliEndpoint {
  /** A Unix socket path, or a Windows named pipe. */
  address: string
  tokenFile: string
}

export function cliEndpoint(userData: string, platform: NodeJS.Platform): CliEndpoint {
  if (platform !== 'win32') {
    return {
      address: path.posix.join(userData, 'cli.sock'),
      tokenFile: path.posix.join(userData, 'cli-token')
    }
  }
  // Pipe names are machine-wide, so derive one from the folder. Windows
  // paths are case-insensitive.
  const id = createHash('sha256')
    .update(path.win32.normalize(userData).toLowerCase())
    .digest('hex')
    .slice(0, 16)
  return {
    address: `\\\\.\\pipe\\envvault-cli-${id}`,
    tokenFile: path.win32.join(userData, 'cli-token')
  }
}
