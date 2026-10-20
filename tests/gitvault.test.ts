// Choosing a git repository as the vault (src/main/gitvault.ts): what a
// repository may already hold, and refusals that need no network.
import { describe, expect, it, vi } from 'vitest'
import { holdsOtherFiles, prepareGitVault } from '../src/main/gitvault'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
vi.mock('../src/main/kdf', () => ({ deriveKeyInWorker: vi.fn() }))

const file = (name: string): { name: string; file: boolean } => ({ name, file: true })

describe('holdsOtherFiles', () => {
  it('allows an empty repository, a vault, and starter files', () => {
    expect(holdsOtherFiles([])).toBe(false)
    expect(
      holdsOtherFiles(
        [
          'meta.json',
          'web.env.enc',
          'api-2.env.enc',
          'platform.0123456789abcdef.file.enc',
          'settings.enc',
          'README.md',
          'readme',
          'LICENSE',
          'LICENSE.txt',
          '.gitignore',
          '.gitattributes'
        ].map(file)
      )
    ).toBe(false)
  })

  it('refuses anything else, so a project repository is not used by mistake', () => {
    for (const entries of [
      [file('package.json')],
      [file('src.env.enc'), { name: 'src', file: false }],
      [{ name: 'README.md', file: false }],
      [file('Web.env.enc')],
      [file('notes.txt')]
    ]) {
      expect(holdsOtherFiles(entries), JSON.stringify(entries)).toBe(true)
    }
  })
})

describe('prepareGitVault', () => {
  it('refuses a URL before running git', async () => {
    for (const url of [
      'file:///tmp/vault.git',
      '/tmp/vault.git',
      'https://u:token@github.com/u/v.git'
    ]) {
      await expect(prepareGitVault(url), url).rejects.toMatchObject({
        code: 'GIT_VAULT_INVALID_URL'
      })
    }
  })
})
