import { describe, expect, it } from 'vitest'
import { passwordProblem } from '../src/core/password'

const WEAK = ['password12345', 'qwertyuiop123', 'P@ssw0rd2026!', 'aaaaaaaaaaaa']

describe('passwordProblem', () => {
  it('refuses common and patterned passwords, with a fixed message', async () => {
    for (const password of WEAK) {
      const problem = await passwordProblem(password, [])
      expect(problem).toMatch(/let your password manager generate one\.$/)
      expect(problem).not.toContain(password)
    }
  })

  it('accepts random words and random characters', async () => {
    expect(await passwordProblem('gravel-orbit-lantern-mosaic', [])).toBeNull()
    expect(await passwordProblem('vivid anchor pumpkin oxygen tundra', [])).toBeNull()
    expect(await passwordProblem('k8#Qz!v2LmR9pX4w', [])).toBeNull()
  })

  it('counts the context words as easy to guess', async () => {
    const password = 'xqvortamlinplumbusvault'
    expect(await passwordProblem(password, [])).toBeNull()
    const problem = await passwordProblem(password, ['xqvortamlin', 'plumbusvault'])
    expect(problem).toMatch(/^Names from this computer/)
    expect(problem).not.toContain('xqvortamlin')
  })

  it('stays fast on the longest password a request allows', async () => {
    const started = performance.now()
    await passwordProblem('!@#$%^&*()1lI0Oo'.repeat(64), [])
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
