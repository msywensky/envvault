// config.json: loading is forgiving, saving is strict, and settings from
// before vault kinds (a plain `vaultPath`) load as a folder vault.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.userData } }))

const root = mkdtempSync(join(tmpdir(), 'envvault-config-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let n = 0
beforeEach(() => {
  h.userData = mkdtempSync(join(root, `u${n++}-`))
  vi.resetModules()
})

const load = async (): Promise<typeof import('../src/main/config')> => import('../src/main/config')

const saved = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(h.userData, 'config.json'), 'utf8')) as Record<string, unknown>

describe('config.json', () => {
  it('loads an old vaultPath as a folder vault, and saves only the new shape', async () => {
    const old = { projectsPath: '/p', vaultPath: '/v', autoLockMinutes: 7, machineName: 'old' }
    writeFileSync(join(h.userData, 'config.json'), JSON.stringify(old))
    const config = await load()
    const cfg = await config.getConfig()
    expect(cfg.vault).toEqual({ kind: 'folder', path: '/v' })
    expect(cfg).not.toHaveProperty('vaultPath')
    expect(cfg.autoLockMinutes).toBe(7)

    await config.updateConfig({ machineName: 'new' })
    expect(saved()['vault']).toEqual({ kind: 'folder', path: '/v' })
    expect(saved()).not.toHaveProperty('vaultPath')
  })

  it('prefers vault over a leftover vaultPath, and drops bad locations', async () => {
    writeFileSync(
      join(h.userData, 'config.json'),
      JSON.stringify({ vault: { kind: 'folder', path: '/new' }, vaultPath: '/old' })
    )
    expect((await (await load()).getConfig()).vault).toEqual({ kind: 'folder', path: '/new' })

    vi.resetModules()
    writeFileSync(join(h.userData, 'config.json'), JSON.stringify({ vault: { kind: 'nas' } }))
    expect((await (await load()).getConfig()).vault).toBeNull()

    vi.resetModules()
    writeFileSync(join(h.userData, 'config.json'), JSON.stringify({ vaultPath: 42 }))
    expect((await (await load()).getConfig()).vault).toBeNull()
  })

  it('starts with no vault', async () => {
    const cfg = await (await load()).getConfig()
    expect(cfg.vault).toBeNull()
    expect(cfg.projectsPath).toBeNull()
  })

  it('keeps the mini window on top unless turned off', async () => {
    expect((await (await load()).getConfig()).miniOnTop).toBe(true)
    vi.resetModules()
    writeFileSync(join(h.userData, 'config.json'), JSON.stringify({ miniOnTop: false }))
    expect((await (await load()).getConfig()).miniOnTop).toBe(false)
  })

  it('has auto-lock on unless turned off', async () => {
    const config = await load()
    const cfg = await config.getConfig()
    expect(cfg.autoLock).toBe(true)
    expect(config.autoLockAfter(cfg)).toBe(5)

    vi.resetModules()
    writeFileSync(join(h.userData, 'config.json'), JSON.stringify({ autoLock: 'no' }))
    expect((await (await load()).getConfig()).autoLock).toBe(true)

    vi.resetModules()
    writeFileSync(join(h.userData, 'config.json'), JSON.stringify({ autoLock: false }))
    const off = await (await load()).getConfig()
    expect(off.autoLock).toBe(false)
    expect((await load()).autoLockAfter(off)).toBeNull()
  })

  it('has automatic pull off, and keeps 3 backups, unless changed', async () => {
    expect(await (await load()).getConfig()).toMatchObject({
      autoPull: false,
      backups: true,
      backupCount: 3
    })

    vi.resetModules()
    writeFileSync(
      join(h.userData, 'config.json'),
      JSON.stringify({ autoPull: true, backups: false, backupCount: 10 })
    )
    expect(await (await load()).getConfig()).toMatchObject({
      autoPull: true,
      backups: false,
      backupCount: 10
    })

    vi.resetModules()
    writeFileSync(join(h.userData, 'config.json'), JSON.stringify({ backupCount: 0 }))
    expect((await (await load()).getConfig()).backupCount).toBe(3)
  })
})
