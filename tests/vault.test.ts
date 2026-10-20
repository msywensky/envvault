// The vault's policy (src/main/vault.ts) on an in-memory store: states,
// create and open, and entries, with no filesystem involved.
import { describe, expect, it, vi } from 'vitest'
import {
  decodeEnv,
  encryptFilePayload,
  encryptSettings,
  makePayload,
  type Payload
} from '../src/core/crypto'
import { ROOT_ENV } from '../src/core/envpath'
import { emptySettings, withRepo, type VaultSettings } from '../src/core/vaultsettings'
import { AppError } from '../src/main/errors'
import { MemorySecrets } from '../src/main/secrets'
import { MemoryStore } from '../src/main/store/memory'
import type { StoreSnapshot } from '../src/main/store/types'
import {
  entryFor,
  entryName,
  isVaultFile,
  stateKey,
  vaultOn,
  withEntryKeys,
  type EntryRef
} from '../src/main/vault'

const h = vi.hoisted(() => ({ derives: 0 }))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
vi.mock('../src/main/kdf', async () => {
  const { deriveKey } = await import('../src/core/crypto')
  return {
    deriveKeyInWorker: (job: { password: string; salt: Uint8Array }) => {
      h.derives++
      return deriveKey(job.password, job.salt, { opslimit: 1, memlimit: 8 * 1024 * 1024 })
    }
  }
})

const PASSWORD = 'correct horse battery staple'
const THEIRS = Buffer.from('{"theirs":true}\n')
const TAG = /^[0-9a-f]{16}$/

const payload = (env: string): Payload => makePayload(Buffer.from(env), 1, 'test')
const root = (repoId: string): EntryRef => ({ kind: 'root', repoId })

const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (err) {
    return (err as { code?: string }).code ?? String(err)
  }
  return 'no error'
}

async function stored(store: MemoryStore, name: string): Promise<Uint8Array> {
  const found = await (await store.snapshot()).get(name)
  if (!found) throw new Error(`${name} is missing`)
  return found.bytes
}

/** Write over whatever the store holds now. */
async function put(store: MemoryStore, name: string, bytes: Uint8Array): Promise<void> {
  const current = await (await store.snapshot()).get(name)
  await store.write(name, bytes, current?.version ?? null)
}

describe('vault policy on a memory store', () => {
  it('goes from empty to ready, and opens with the right password only', async () => {
    const vault = vaultOn(new MemoryStore())
    expect(await vault.state()).toBe('empty')
    expect(await errorCode(vault.open(PASSWORD))).toBe('VAULT_NOT_FOUND')
    expect(await errorCode(vault.create('too short'))).toBe('PASSWORD_TOO_SHORT')
    // Refused before the key is derived.
    const derives = h.derives
    expect(await errorCode(vault.create('password12345'))).toBe('PASSWORD_WEAK')
    expect(h.derives).toBe(derives)

    const created = await vault.create(PASSWORD)
    expect(await vault.state()).toBe('ready')
    expect(await errorCode(vault.create(PASSWORD))).toBe('VAULT_EXISTS')

    const opened = await vault.open(PASSWORD)
    expect(opened.vaultId).toBe(created.vaultId)
    expect(Buffer.from(opened.key).equals(Buffer.from(created.key))).toBe(true)
    expect(await errorCode(vault.open('wrong password!!'))).toBe('WRONG_PASSWORD')
  })

  it('refuses a vault whose meta.json is missing or invalid', async () => {
    const store = new MemoryStore()
    const vault = vaultOn(store)
    await put(store, 'web.env.enc', new Uint8Array([1, 2, 3]))
    expect(await vault.state()).toBe('meta-missing')
    expect(await errorCode(vault.create(PASSWORD))).toBe('VAULT_META_MISSING')

    await put(store, 'meta.json', Buffer.from('{not json'))
    expect(await vault.state()).toBe('ready')
    expect(await errorCode(vault.open(PASSWORD))).toBe('META_INVALID')
    await put(store, 'meta.json', Buffer.from('{"formatVersion":1}'))
    expect(await errorCode(vault.open(PASSWORD))).toBe('META_INVALID')
  })

  it('reports an unreachable store as a missing folder', async () => {
    const vault = vaultOn(new MemoryStore({ reachable: false }))
    expect(await vault.state()).toBe('folder-missing')
    expect(await errorCode(vault.create(PASSWORD))).toBe('VAULT_FOLDER_MISSING')
    expect(await errorCode(vault.open(PASSWORD))).toBe('VAULT_FOLDER_MISSING')
  })

  it('asks the store before creating or opening, and stops before deriving a key', async () => {
    class Refuses extends MemoryStore {
      refuse = false
      override async check(): Promise<void> {
        if (this.refuse) throw new AppError('INTERNAL', 'Not now.')
      }
    }
    const store = new Refuses()
    const vault = vaultOn(store)
    store.refuse = true
    const before = h.derives
    expect(await errorCode(vault.create(PASSWORD))).toBe('INTERNAL')
    expect(await vault.state()).toBe('empty')
    store.refuse = false
    await vault.create(PASSWORD)
    store.refuse = true
    expect(await errorCode(vault.open(PASSWORD))).toBe('INTERNAL')
    expect(h.derives).toBe(before + 1)
  })

  it('never creates over a vault that appears while the key is derived', async () => {
    // The second snapshot is the re-check after deriving the key.
    class AppearsMeanwhile extends MemoryStore {
      private calls = 0
      override async snapshot(): Promise<StoreSnapshot> {
        if (++this.calls === 2) await this.write('meta.json', THEIRS, null)
        return super.snapshot()
      }
    }
    const store = new AppearsMeanwhile()
    expect(await errorCode(vaultOn(store).create(PASSWORD))).toBe('VAULT_EXISTS')
    expect(Buffer.from(await stored(store, 'meta.json')).equals(THEIRS)).toBe(true)
  })

  it('loses a create race to a vault that appears at the same moment', async () => {
    class RacingCreate extends MemoryStore {
      override async write(
        name: string,
        bytes: Uint8Array,
        expected: string | null
      ): Promise<string> {
        if (name === 'meta.json') await super.write(name, THEIRS, null)
        return super.write(name, bytes, expected)
      }
    }
    const store = new RacingCreate()
    expect(await errorCode(vaultOn(store).create(PASSWORD))).toBe('VAULT_EXISTS')
    expect(Buffer.from(await stored(store, 'meta.json')).equals(THEIRS)).toBe(true)
  })

  it('reads back what it wrote, and catches tampered and swapped entries', async () => {
    const store = new MemoryStore()
    const vault = vaultOn(store)
    const { key } = await vault.create(PASSWORD)
    await withEntryKeys(key, async (keys) => {
      const write = (repoName: string, env: string): Promise<string> =>
        vault.write(keys, { repoName, path: ROOT_ENV }, payload(env), null)
      const webVersion = await write('web', 'A=1\n')
      await write('api', 'B=2\n')
      await put(store, 'notes.txt', Buffer.from('not an entry'))

      const snapshot = await vault.snapshot()
      expect(snapshot.entries.map(entryName).sort()).toEqual(['api.env.enc', 'web.env.enc'])
      const web = await snapshot.read(keys, root('web'))
      expect(web && decodeEnv(web.payload).toString('utf8')).toBe('A=1\n')
      expect(web?.version).toBe(webVersion)
      expect(web?.path).toBe(ROOT_ENV)
      expect(await snapshot.read(keys, root('missing'))).toBeNull()

      // The entry name is bound into the encryption: a copy under another name fails.
      await put(store, 'api.env.enc', await stored(store, 'web.env.enc'))
      expect(await errorCode((await vault.snapshot()).read(keys, root('api')))).toBe(
        'VAULT_TAMPERED'
      )

      const bytes = await stored(store, 'web.env.enc')
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
      await put(store, 'web.env.enc', bytes)
      expect(await errorCode((await vault.snapshot()).read(keys, root('web')))).toBe(
        'VAULT_TAMPERED'
      )
    })
  })

  it('refuses to write over an entry that changed since its snapshot', async () => {
    const store = new MemoryStore()
    const vault = vaultOn(store)
    const { key } = await vault.create(PASSWORD)
    await withEntryKeys(key, async (keys) => {
      const web = { repoName: 'web', path: ROOT_ENV }
      const v1 = await vault.write(keys, web, payload('A=1\n'), null)
      const before = await vault.snapshot()
      await vault.write(keys, web, payload('A=2\n'), v1)

      const entry = await before.read(keys, root('web'))
      expect(entry?.version).toBe(v1)
      expect(await errorCode(vault.write(keys, web, payload('A=3\n'), v1))).toBe('VAULT_CHANGED')
      expect(await errorCode(vault.write(keys, web, payload('A=3\n'), null))).toBe('VAULT_CHANGED')
      const now = await (await vault.snapshot()).read(keys, root('web'))
      expect(now && decodeEnv(now.payload).toString('utf8')).toBe('A=2\n')
    })
  })
})

describe('env files in subfolders', () => {
  it('keeps them under names that hide their paths', async () => {
    const store = new MemoryStore()
    const vault = vaultOn(store)
    const { key } = await vault.create(PASSWORD)
    await withEntryKeys(key, async (keys) => {
      const web = { repoName: 'Platform', path: 'apps/Web/.env' }
      const version = await vault.write(keys, web, payload('W=1\n'), null)
      await vault.write(keys, { repoName: 'platform', path: ROOT_ENV }, payload('R=1\n'), null)
      const ref = entryFor(keys, web)
      expect(ref).toEqual({ kind: 'file', repoId: 'platform', tag: expect.stringMatching(TAG) })
      // Case-insensitive, like the filesystems.
      expect(entryFor(keys, { repoName: 'platform', path: 'apps/web/.env' })).toEqual(ref)
      expect(entryFor(keys, { repoName: 'platform', path: 'apps/api/.env' })).not.toEqual(ref)

      const names = (await store.snapshot()).names.sort()
      expect(names).toEqual(['meta.json', 'platform.env.enc', entryName(ref)].sort())
      expect(names.join(' ')).not.toContain('apps')
      expect(names.every((name) => isVaultFile(name))).toBe(true)

      const snapshot = await vault.snapshot()
      expect(snapshot.entries).toContainEqual(ref)
      const entry = await snapshot.read(keys, ref)
      expect(entry).toMatchObject({ path: 'apps/Web/.env', version })
      expect(entry?.payload).not.toHaveProperty('path')
      expect(entry && decodeEnv(entry.payload).toString('utf8')).toBe('W=1\n')
      // The root entry has no path.
      const rootEntry = await snapshot.read(keys, root('platform'))
      expect(rootEntry?.path).toBe(ROOT_ENV)
      expect(stateKey(ref)).toBe(`platform/${ref.kind === 'file' ? ref.tag : ''}`)
      expect(stateKey(root('platform'))).toBe('platform')
    })
  })

  it('tells root and file entries apart, even for a repo named like a file entry', async () => {
    const store = new MemoryStore()
    const bytes = new Uint8Array([1])
    for (const name of [
      'web.0123456789abcdef.env.enc',
      'web.0123456789abcdef.file.enc',
      'web.0123456789abcde.file.enc',
      'web.0123456789abcdeg.file.enc',
      'web.file.enc',
      'con.0123456789abcdef.file.enc',
      'con.env.enc'
    ]) {
      await put(store, name, bytes)
    }
    const { entries } = await vaultOn(store).snapshot()
    expect(entries).toHaveLength(2)
    expect(entries).toContainEqual({ kind: 'root', repoId: 'web.0123456789abcdef' })
    expect(entries).toContainEqual({ kind: 'file', repoId: 'web', tag: '0123456789abcdef' })
    expect(isVaultFile('web.0123456789abcdef.file.enc')).toBe(true)
    expect(isVaultFile('web.0123456789abcde.file.enc')).toBe(false)
    expect(isVaultFile('web.file.enc')).toBe(false)
  })

  it('catches swapped and mislabelled file entries', async () => {
    const store = new MemoryStore()
    const vault = vaultOn(store)
    const { key } = await vault.create(PASSWORD)
    await withEntryKeys(key, async (keys) => {
      const web = { repoName: 'platform', path: 'apps/web/.env' }
      const api = { repoName: 'platform', path: 'apps/api/.env' }
      await vault.write(keys, web, payload('W=1\n'), null)
      await vault.write(keys, api, payload('A=1\n'), null)
      await vault.write(keys, { repoName: 'platform', path: ROOT_ENV }, payload('R=1\n'), null)
      const [webRef, apiRef] = [entryFor(keys, web), entryFor(keys, api)]
      const read = async (ref: EntryRef): Promise<string> =>
        errorCode((await vault.snapshot()).read(keys, ref))

      // Copied over another file, or over the root entry.
      await put(store, entryName(apiRef), await stored(store, entryName(webRef)))
      expect(await read(apiRef)).toBe('VAULT_TAMPERED')
      await put(store, 'platform.env.enc', await stored(store, entryName(webRef)))
      expect(await read(root('platform'))).toBe('VAULT_TAMPERED')

      // Encrypted for its name, but with a path that hashes to another name.
      if (apiRef.kind !== 'file') throw new Error('expected a file entry')
      const lying = { ...payload('A=2\n'), path: 'apps/web/.env' }
      await put(
        store,
        entryName(apiRef),
        await encryptFilePayload(key, 'platform', apiRef.tag, lying)
      )
      expect(await read(apiRef)).toBe('VAULT_TAMPERED')
      expect(
        await (await vault.snapshot()).read(keys, apiRef).catch((e: Error) => e.message)
      ).toMatch(/an env file in "platform" \(platform\.[0-9a-f]{16}\.file\.enc\)/)

      // A file entry claiming to be the root .env.
      const rootTag = keys.tagger.tag('platform', ROOT_ENV)
      const asRoot: EntryRef = { kind: 'file', repoId: 'platform', tag: rootTag }
      const claim = { ...payload('R=2\n'), path: ROOT_ENV }
      await put(store, entryName(asRoot), await encryptFilePayload(key, 'platform', rootTag, claim))
      expect(await read(asRoot)).toBe('VAULT_TAMPERED')

      expect(await read(webRef)).toBe('no error')
    })
  })

  it('tells a file this version does not sync from a tampered one', async () => {
    const store = new MemoryStore()
    const vault = vaultOn(store)
    const { key } = await vault.create(PASSWORD)
    await withEntryKeys(key, async (keys) => {
      // What a newer EnvVault might sync: its tag matches, so it was written with the key.
      const path = 'apps/web/.env.example'
      const tag = keys.tagger.tag('platform', path)
      const ref: EntryRef = { kind: 'file', repoId: 'platform', tag }
      const bytes = await encryptFilePayload(key, 'platform', tag, { ...payload('A=1\n'), path })
      await put(store, entryName(ref), bytes)
      const read = (await vault.snapshot()).read(keys, ref)
      expect(await errorCode(read)).toBe('VAULT_NEEDS_UPDATE')

      // The same entry under another tag is still tampering.
      const other: EntryRef = { kind: 'file', repoId: 'platform', tag: '0123456789abcdef' }
      const moved = { ...payload('A=1\n'), path }
      await put(
        store,
        entryName(other),
        await encryptFilePayload(key, 'platform', other.tag, moved)
      )
      expect(await errorCode((await vault.snapshot()).read(keys, other))).toBe('VAULT_TAMPERED')
    })
  })

  it('accepts env file variants', async () => {
    const vault = vaultOn(new MemoryStore())
    const { key } = await vault.create(PASSWORD)
    await withEntryKeys(key, async (keys) => {
      for (const path of ['.env.local', 'apps/web/.env.production.local']) {
        const file = { repoName: 'platform', path }
        await vault.write(keys, file, payload('A=1\n'), null)
        const entry = await (await vault.snapshot()).read(keys, entryFor(keys, file))
        expect(entry?.path).toBe(path)
      }
    })
  })

  it('removes an entry only at the version it was read at', async () => {
    const store = new MemoryStore()
    const vault = vaultOn(store)
    const { key } = await vault.create(PASSWORD)
    await withEntryKeys(key, async (keys) => {
      const web = { repoName: 'platform', path: 'apps/web/.env' }
      const v1 = await vault.write(keys, web, payload('W=1\n'), null)
      const v2 = await vault.write(keys, web, payload('W=2\n'), v1)
      const ref = entryFor(keys, web)
      expect(await errorCode(vault.remove(ref, v1))).toBe('VAULT_CHANGED')
      await vault.remove(ref, v2)
      expect((await vault.snapshot()).entries).toEqual([])
      expect(await errorCode(vault.remove(ref, v2))).toBe('VAULT_CHANGED')
      expect((await store.snapshot()).names).toEqual(['meta.json'])

      const rootVersion = await vault.write(
        keys,
        { repoName: 'web', path: ROOT_ENV },
        payload('A=1\n'),
        null
      )
      await vault.remove(root('web'), rootVersion)
      expect((await store.snapshot()).names).toEqual(['meta.json'])
    })
  })

  it('refuses an env file that is not one', async () => {
    const vault = vaultOn(new MemoryStore())
    const { key } = await vault.create(PASSWORD)
    await withEntryKeys(key, async (keys) => {
      for (const file of [
        { repoName: 'platform', path: '../.env' },
        { repoName: 'platform', path: 'apps/web/.env.example' },
        { repoName: '../x', path: ROOT_ENV }
      ]) {
        expect(() => entryFor(keys, file)).toThrow('Not an env file.')
      }
    })
  })
})

describe('repo settings', () => {
  const ignoring = (doc: VaultSettings, repoId: string): VaultSettings =>
    withRepo(doc, repoId, { ignored: true, include: null, exclude: null })

  it('starts with the built-in settings, then reads back what it wrote', async () => {
    const store = new MemoryStore()
    const vault = vaultOn(store)
    const { key } = await vault.create(PASSWORD)
    await withEntryKeys(key, async (keys) => {
      const first = await (await vault.snapshot()).settings(keys)
      expect(first).toEqual({ settings: emptySettings(), version: null, error: null })

      const written = ignoring(first.settings, 'web')
      const version = await vault.writeSettings(keys, written, null)
      const read = await (await vault.snapshot()).settings(keys)
      expect(read).toEqual({ settings: written, version, error: null })
      expect((await store.snapshot()).names).toEqual(['meta.json', 'settings.enc'])
      expect(isVaultFile('settings.enc')).toBe(true)
      // Not an entry, so never listed as a repo.
      expect((await vault.snapshot()).entries).toEqual([])
    })
  })

  it('refuses to write over settings that changed since they were read', async () => {
    const vault = vaultOn(new MemoryStore())
    const { key } = await vault.create(PASSWORD)
    await withEntryKeys(key, async (keys) => {
      const v1 = await vault.writeSettings(keys, ignoring(emptySettings(), 'web'), null)
      expect(await errorCode(vault.writeSettings(keys, emptySettings(), null))).toBe(
        'VAULT_CHANGED'
      )
      await vault.writeSettings(keys, ignoring(emptySettings(), 'api'), v1)
      expect(await errorCode(vault.writeSettings(keys, emptySettings(), v1))).toBe('VAULT_CHANGED')
    })
  })

  it('falls back to the built-in settings when they cannot be read', async () => {
    const store = new MemoryStore()
    const vault = vaultOn(store)
    const { key } = await vault.create(PASSWORD)
    await withEntryKeys(key, async (keys) => {
      const read = async (): Promise<{ code: string | null; version: string | null }> => {
        const r = await (await vault.snapshot()).settings(keys)
        expect(r.settings).toEqual(emptySettings())
        return { code: r.error?.code ?? null, version: r.version }
      }

      // An entry copied over the settings.
      await vault.write(keys, { repoName: 'web', path: ROOT_ENV }, payload('A=1\n'), null)
      await put(store, 'settings.enc', await stored(store, 'web.env.enc'))
      const tampered = await read()
      expect(tampered.code).toBe('VAULT_TAMPERED')
      // Its version is known, so a reset can write over it.
      await vault.writeSettings(keys, emptySettings(), tampered.version)

      // Encrypted with the key but not settings this version can read.
      await put(store, 'settings.enc', await encryptSettings(key, { format: 1, repos: [] }))
      expect((await read()).code).toBe('VAULT_TAMPERED')
      await put(
        store,
        'settings.enc',
        await encryptSettings(key, { ...emptySettings(), format: 2 })
      )
      expect((await read()).code).toBe('VAULT_NEEDS_UPDATE')
      await put(store, 'settings.enc', new Uint8Array(400 * 1024))
      expect((await read()).code).toBe('VAULT_TAMPERED')
    })
  })

  it('counts settings without meta.json as a vault missing its meta.json', async () => {
    const store = new MemoryStore()
    await store.write('settings.enc', new Uint8Array([1]), null)
    expect(await vaultOn(store).state()).toBe('meta-missing')
  })
})

describe('format 2: a secret on each machine, moved as a setup code', () => {
  const meta = async (store: MemoryStore): Promise<Record<string, unknown>> =>
    JSON.parse(Buffer.from(await stored(store, 'meta.json')).toString('utf8')) as Record<
      string,
      unknown
    >
  const putMeta = async (store: MemoryStore, json: Record<string, unknown>): Promise<void> =>
    put(store, 'meta.json', Buffer.from(JSON.stringify(json)))

  it('creates with a code, and opens on the same machine without one', async () => {
    const store = new MemoryStore()
    const a = vaultOn(store, new MemorySecrets())
    const created = await a.create(PASSWORD, { setupCode: true })
    expect(created.setupCode).toMatch(/^EV(-[0-9A-Z]{5}){5}-[0-9A-Z]{4}$/)
    expect(await meta(store)).toMatchObject({ formatVersion: 2, secretId: expect.any(String) })
    expect(JSON.stringify(await meta(store))).not.toContain(created.setupCode?.slice(3, 8))
    expect(await a.setupCodeState()).toBe('saved')
    const opened = await a.open(PASSWORD)
    expect(Buffer.from(opened.key).equals(Buffer.from(created.key))).toBe(true)
  })

  it('needs the code on another machine, and keeps it only once the password is right', async () => {
    const store = new MemoryStore()
    const { setupCode } = await vaultOn(store, new MemorySecrets()).create(PASSWORD, {
      setupCode: true
    })
    const other = await vaultOn(new MemoryStore(), new MemorySecrets()).create(PASSWORD, {
      setupCode: true
    })
    const machineB = new MemorySecrets()
    const b = vaultOn(store, machineB)
    expect(await b.setupCodeState()).toBe('needed')
    expect(await errorCode(b.open(PASSWORD))).toBe('SETUP_CODE_REQUIRED')
    expect(await errorCode(b.open(PASSWORD, 'not a code'))).toBe('SETUP_CODE_INVALID')
    expect(await errorCode(b.open(PASSWORD, other.setupCode ?? ''))).toBe('SETUP_CODE_WRONG')
    expect(await errorCode(b.open('wrong password!!', setupCode ?? ''))).toBe('WRONG_PASSWORD')
    expect(await b.setupCodeState()).toBe('needed')
    await b.open(PASSWORD, (setupCode ?? '').toLowerCase().replace(/-/g, ' '))
    expect(await b.setupCodeState()).toBe('saved')
    await b.open(PASSWORD)
  })

  it('shows the code again only with the right password', async () => {
    const store = new MemoryStore()
    const a = vaultOn(store, new MemorySecrets())
    const { setupCode } = await a.create(PASSWORD, { setupCode: true })
    expect(await a.showSetupCode(PASSWORD)).toBe(setupCode)
    expect(await errorCode(a.showSetupCode('wrong password!!'))).toBe('WRONG_PASSWORD')
    expect(await errorCode(vaultOn(store, new MemorySecrets()).showSetupCode(PASSWORD))).toBe(
      'SETUP_CODE_REQUIRED'
    )
  })

  it('fails closed when meta.json is edited', async () => {
    const store = new MemoryStore()
    const a = vaultOn(store, new MemorySecrets())
    const { setupCode } = await a.create(PASSWORD, { setupCode: true })
    const original = await meta(store)

    // Back to format 1: the password alone derives a different key.
    const { secretId: _secretId, ...v1 } = original
    void _secretId
    await putMeta(store, { ...v1, formatVersion: 1 })
    expect(await a.setupCodeState()).toBe('not-used')
    expect(await errorCode(a.open(PASSWORD))).toBe('WRONG_PASSWORD')

    // Another secretId: neither the saved secret nor the real code matches it.
    await putMeta(store, { ...original, secretId: Buffer.alloc(16, 7).toString('base64') })
    expect(await a.setupCodeState()).toBe('needed')
    expect(await errorCode(a.open(PASSWORD))).toBe('SETUP_CODE_REQUIRED')
    expect(await errorCode(a.open(PASSWORD, setupCode ?? ''))).toBe('SETUP_CODE_WRONG')

    await putMeta(store, original)
    await a.open(PASSWORD)
  })

  it('keeps format 1 for a vault made without a code', async () => {
    const store = new MemoryStore()
    const secrets = new MemorySecrets()
    const v = vaultOn(store, secrets)
    const created = await v.create(PASSWORD)
    expect(created.setupCode).toBeNull()
    expect(await meta(store)).toMatchObject({ formatVersion: 1 })
    expect(await meta(store)).not.toHaveProperty('secretId')
    expect(await v.setupCodeState()).toBe('not-used')
    expect(await errorCode(v.showSetupCode(PASSWORD))).toBe('NO_SETUP_CODE')
    await vaultOn(store, new MemorySecrets()).open(PASSWORD)
  })

  it("doesn't keep a secret for a vault that wasn't created", async () => {
    class RacingCreate extends MemoryStore {
      override async write(
        name: string,
        bytes: Uint8Array,
        expected: string | null
      ): Promise<string> {
        if (name === 'meta.json') await super.write(name, THEIRS, null)
        return super.write(name, bytes, expected)
      }
    }
    const saved: string[] = []
    class Watching extends MemorySecrets {
      override async forget(vaultId: string): Promise<void> {
        saved.splice(saved.indexOf(vaultId), 1)
        return super.forget(vaultId)
      }
      override async save(vaultId: string, secret: Uint8Array): Promise<void> {
        saved.push(vaultId)
        return super.save(vaultId, secret)
      }
    }
    const v = vaultOn(new RacingCreate(), new Watching())
    expect(await errorCode(v.create(PASSWORD, { setupCode: true }))).toBe('VAULT_EXISTS')
    expect(saved).toEqual([])
  })

  it('writes nothing when this machine cannot keep the secret', async () => {
    class Unavailable extends MemorySecrets {
      override async save(): Promise<void> {
        throw new AppError('SECRET_STORE_UNAVAILABLE', 'no')
      }
    }
    const store = new MemoryStore()
    const v = vaultOn(store, new Unavailable())
    expect(await errorCode(v.create(PASSWORD, { setupCode: true }))).toBe(
      'SECRET_STORE_UNAVAILABLE'
    )
    expect(await v.state()).toBe('empty')
  })
})
