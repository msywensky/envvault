// config.json: loading is forgiving, saving is strict.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

describe('config.json', () => {
  it('loads a vault location, and drops a bad one', async () => {
    const vault = { kind: 'folder', path: '/v' }
    writeFileSync(join(h.userData, 'config.json'), JSON.stringify({ vault }))
    expect((await (await load()).getConfig()).vault).toEqual(vault)

    vi.resetModules()
    writeFileSync(join(h.userData, 'config.json'), JSON.stringify({ vault: { kind: 'nas' } }))
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

  it('syncs every folder under its own name unless told otherwise', async () => {
    expect((await (await load()).getConfig()).repoNames).toEqual({})
    vi.resetModules()
    writeFileSync(
      join(h.userData, 'config.json'),
      JSON.stringify({ repoNames: { 'app-wt': 'app' } })
    )
    const config = await load()
    expect((await config.getConfig()).repoNames).toEqual({ 'app-wt': 'app' })
    // Saved as it was loaded.
    await config.updateConfig({ machineName: 'm' })
    vi.resetModules()
    expect((await (await load()).getConfig()).repoNames).toEqual({ 'app-wt': 'app' })

    // A folder id must be lowercase, and both must be repo names: else nothing is kept.
    for (const repoNames of [{ App: 'app' }, { app: '../x' }, ['app'], 'app']) {
      vi.resetModules()
      writeFileSync(join(h.userData, 'config.json'), JSON.stringify({ repoNames }))
      expect((await (await load()).getConfig()).repoNames).toEqual({})
    }
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
