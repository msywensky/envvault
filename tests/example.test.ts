import { describe, expect, it } from 'vitest'
import { parseEnv } from '../src/core/envdiff'
import { compareExample, looksSecret } from '../src/core/example'

describe('looksSecret', () => {
  it('stays quiet for values commonly shared with the example', () => {
    for (const [key, value] of [
      ['URL', 'http://localhost:3000'],
      ['PORT', '3000'],
      ['NODE_ENV', 'development'],
      ['API_URL', 'https://api.example.com'],
      ['DATABASE_URL', 'postgres://postgres:postgres@localhost/app'],
      ['VITE_FIREBASE_API_KEY', 'AIzaSyD4x9Qk2mN7pL0vR8tW3yZ6bC1eF5gH'],
      ['NEXT_PUBLIC_STRIPE_KEY', 'pk_test_51H8abcDEF123ghiJKL'],
      ['S3_BUCKET', 'my-app-uploads']
    ] as const) {
      expect(looksSecret(key, value), `${key}=${value}`).toBe(false)
    }
  })

  it('flags real-looking secrets', () => {
    for (const [key, value] of [
      ['DATABASE_URL', 'postgres://app:pw@db.prod.example.com/app'],
      ['STRIPE_KEY', 'sk_test_51H8abcDEF123ghiJKL'],
      ['JWT_SECRET', 'dev-secret-change-me'],
      ['CACHE_URL', 'redis://:pass@cache.internal:6379']
    ] as const) {
      expect(looksSecret(key, value), `${key}=${value}`).toBe(true)
    }
  })

  it('treats URLs with a password on a local host as defaults', () => {
    for (const value of [
      'redis://:pw@[::1]:6379',
      'postgres://u:p@127.0.0.1/db',
      'postgres://u:p@0.0.0.0/db',
      'postgres://u:p@host.docker.internal/db',
      'postgres://u:p@db.local/db',
      'postgres://u:p@app.localhost/db',
      'postgres://u:p@LOCALHOST/db'
    ]) {
      expect(looksSecret('DATABASE_URL', value), value).toBe(false)
    }
    // A user name alone (a Sentry DSN) is not a password.
    expect(looksSecret('SENTRY_DSN', 'https://abc123def456@o1.ingest.sentry.io/42')).toBe(false)
  })

  it('judges a URL only by its password, but an unparsable one by the other rules', () => {
    expect(looksSecret('AUTH_TOKEN_URL', 'https://auth.example.com/oauth/token')).toBe(false)
    expect(looksSecret('DB_PASSWORD', 'postgres://u:p@bad host/db')).toBe(true)
  })

  it('needs 8+ characters under a secret-sounding name', () => {
    expect(looksSecret('API_KEY', 'abc123')).toBe(false)
    expect(looksSecret('CACHE_KEY_TTL', '3600')).toBe(false)
    expect(looksSecret('ADMIN_PASSWORD', 'hunter22')).toBe(true)
    expect(looksSecret('db.password', 'longenough')).toBe(true)
    // KEY must be a whole part of the name.
    expect(looksSecret('MONKEY_NAME', 'bananas-forever')).toBe(false)
  })

  it('recognises token-like values but not paths or dates', () => {
    expect(looksSecret('APP_ID', '550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(looksSecret('DATA_DIR', '/Users/me/projects/app2/data')).toBe(false)
    expect(looksSecret('DATA_DIR', 'C:\\Users\\me\\projects\\app2')).toBe(false)
    expect(looksSecret('STARTS_AT', '2026-01-01T00:00:00Z')).toBe(false)
    expect(looksSecret('GREETING', 'hello world 12345 abcdefg')).toBe(false)
  })

  it('never flags an empty value', () => {
    expect(looksSecret('API_SECRET', '')).toBe(false)
  })
})

describe('compareExample', () => {
  const compare = (env: string, example: string): ReturnType<typeof compareExample> =>
    compareExample(parseEnv(env), parseEnv(example))

  it('lists missing, undocumented and secret same-value keys, sorted', () => {
    expect(
      compare(
        'URL=http://localhost:3000\nPORT=3000\nZ_TOKEN=tok_9f8e7d6c5b4a3210\nA_SECRET=same-secret\nNEW=1\n',
        'URL=http://localhost:3000\nPORT=3000\nZ_TOKEN=tok_9f8e7d6c5b4a3210\nA_SECRET=same-secret\nB=\nA=\n'
      )
    ).toEqual({ sameValue: ['A_SECRET', 'Z_TOKEN'], missing: ['A', 'B'], undocumented: ['NEW'] })
  })

  it('flags only identical values', () => {
    expect(compare('API_SECRET=real-secret-value\n', 'API_SECRET=your-secret-here\n')).toEqual({
      sameValue: [],
      missing: [],
      undocumented: []
    })
  })

  it('treats keys commented out in the example as optional', () => {
    expect(compare('A=1\n', 'A=1\n# OPTIONAL=\n#OTHER=x\n').missing).toEqual([])
  })

  it('counts a key with an empty value as present', () => {
    expect(compare('DB_PATH=\n', 'DB_PATH=/path/to/data\n').missing).toEqual([])
  })

  it('compares an empty .env or example', () => {
    expect(compare('', 'A=1\n')).toEqual({ sameValue: [], missing: ['A'], undocumented: [] })
    expect(compare('A=1\n', '')).toEqual({ sameValue: [], missing: [], undocumented: ['A'] })
  })
})
