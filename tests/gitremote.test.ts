// Git remote URLs and branch names for a git vault (src/core/gitremote.ts).
import { describe, expect, it } from 'vitest'
import { GitRemoteError, isBranchName, parseGitRemote } from '../src/core/gitremote'

const refusal = (url: string): string => {
  try {
    parseGitRemote(url)
  } catch (err) {
    if (err instanceof GitRemoteError) return err.message
    throw err
  }
  return 'accepted'
}

describe('parseGitRemote', () => {
  it.each([
    ['https://github.com/you/vault.git', 'https', 'github.com', '/you/vault.git'],
    [
      'https://gitlab.example.com:8443/group/sub/vault',
      'https',
      'gitlab.example.com',
      '/group/sub/vault'
    ],
    ['ssh://git@github.com/you/vault.git', 'ssh', 'github.com', '/you/vault.git'],
    ['ssh://host.example:2222/srv/vault.git', 'ssh', 'host.example', '/srv/vault.git'],
    ['git@github.com:you/vault.git', 'scp', 'github.com', 'you/vault.git'],
    ['git_user@git.example.org:/srv/git/vault.git', 'scp', 'git.example.org', '/srv/git/vault.git'],
    ['git@host:~me/vault', 'scp', 'host', '~me/vault']
  ])('accepts %s', (url, form, host, path) => {
    expect(parseGitRemote(url)).toEqual({ form, url, host, path })
  })

  it('refuses credentials in the URL, without echoing them', () => {
    for (const url of [
      'https://you:ghp_secret@github.com/you/vault.git',
      'https://ghp_secret@github.com/you/vault.git',
      'ssh://git:secret@github.com/you/vault.git'
    ]) {
      const message = refusal(url)
      expect(message, url).toMatch(/credentials/)
      expect(message).not.toContain('secret')
    }
  })

  it.each([
    '',
    'file:///tmp/vault.git',
    '/tmp/vault.git',
    './vault',
    'C:\\vaults\\v.git',
    'C:/vaults/v.git',
    'ext::sh -c touch% /tmp/pwned',
    'git://github.com/you/vault.git',
    'ftp://host/vault.git',
    'HTTPS://github.com/you/vault.git',
    'http://github.com/you/vault.git',
    '-oProxyCommand=evil',
    'ssh://-oProxyCommand=evil/x',
    'git@-oProxyCommand=evil:x',
    '-u@host:x',
    'git@host:-x',
    'https://github.com/you/vault.git ',
    'https://github.com/you/my vault.git',
    'https://github.com/you/vault.git\n',
    'https://github.com/you/vault.git?x=1',
    'https://github.com/you/vault.git#main',
    'https://[::1]/vault.git',
    'https://github.com/',
    'https://github.com/you/../../etc',
    'https://host:0/x',
    'https://host:70000/x',
    'host:path',
    `https://github.com/${'a'.repeat(2048)}`
  ])('refuses %j', (url) => {
    expect(refusal(url)).not.toBe('accepted')
  })

  it('never echoes the input in a refusal', () => {
    expect(refusal('ext::sh -c PAYLOAD')).not.toContain('PAYLOAD')
    expect(refusal('file:///PAYLOAD')).not.toContain('PAYLOAD')
  })
})

describe('isBranchName', () => {
  it.each(['main', 'master', 'envvault', 'vault/main', 'release-1.2', 'a_b'])('accepts %s', (b) => {
    expect(isBranchName(b)).toBe(true)
  })

  it.each([
    '',
    '-main',
    '/main',
    'main/',
    'main.',
    '.main',
    'a..b',
    'a//b',
    'a/.b',
    'main.lock',
    'a.lock/b',
    'a@{1}',
    'a b',
    'a~1',
    'a^',
    'a:b',
    'x'.repeat(101)
  ])('refuses %j', (b) => {
    expect(isBranchName(b)).toBe(false)
  })
})
