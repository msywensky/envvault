import { describe, expect, it } from 'vitest'
import { cliEndpoint } from '../src/core/cliendpoint'

describe('cliEndpoint', () => {
  it('uses a socket and a token file in userData on macOS', () => {
    const dir = '/Users/me/Library/Application Support/envvault'
    expect(cliEndpoint(dir, 'darwin')).toEqual({
      address: `${dir}/cli.sock`,
      tokenFile: `${dir}/cli-token`
    })
  })

  it('derives a stable named pipe per userData folder on Windows', () => {
    const dir = 'C:\\Users\\me\\AppData\\Roaming\\envvault'
    const a = cliEndpoint(dir, 'win32')
    expect(a.address).toMatch(/^\\\\\.\\pipe\\envvault-cli-[0-9a-f]{16}$/)
    expect(a.tokenFile).toBe(`${dir}\\cli-token`)
    expect(cliEndpoint(dir, 'win32')).toEqual(a)
    // Windows paths are case-insensitive, so the pipe name is too.
    expect(cliEndpoint('c:\\users\\ME\\appdata\\roaming\\EnvVault', 'win32').address).toBe(
      a.address
    )
    // Each profile and each user gets its own.
    expect(cliEndpoint(`${dir}-kvtest`, 'win32').address).not.toBe(a.address)
    expect(cliEndpoint('C:\\Users\\you\\AppData\\Roaming\\envvault', 'win32').address).not.toBe(
      a.address
    )
  })
})
