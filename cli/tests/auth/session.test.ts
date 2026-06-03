/**
 * Spec: §6, §7 + Task 12 — v2 OAuth session storage on disk.
 *
 * Each test gets a fresh tmp HOME. The actual perm + atomic-write logic
 * lives in `paths.ts`, so this file pins the session-shape contract and
 * the wiring from `readSession`/`writeSession` to those primitives.
 *
 * v2 change: old v1 (Clerk-ticket) sessions must be rejected by readSession()
 * so the user is forced to re-authenticate via OAuth PKCE.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotLoggedInError, type SessionState, readSession, sessionFilePath, writeSession } from '../../src/auth/session'

let tempHome: string
let originalHome: string | undefined

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-session-test-'))
  originalHome = process.env.HOME
  vi.stubEnv('HOME', tempHome)
})

afterEach(() => {
  if (originalHome !== undefined) {
    vi.stubEnv('HOME', originalHome)
  }
  rmSync(tempHome, { recursive: true, force: true })
})

const sample: SessionState = {
  version: 2,
  accessToken: 'access-jwt',
  accessTokenExpiry: 1_700_000_900,
  refreshToken: 'refresh-token',
  idToken: 'id-jwt',
  frontendApiUrl: 'https://clear-redbird-6.clerk.accounts.dev',
  clientId: 'client_test123',
  convexUrl: 'https://beloved-mouse-707.convex.cloud',
  machineLabel: 'dev-laptop',
}

describe('sessionFilePath', () => {
  it('returns ~/.vault/session.json', () => {
    expect(sessionFilePath()).toBe(join(tempHome, '.vault', 'session.json'))
  })
})

describe('writeSession + readSession', () => {
  it('round-trips a v2 session through the disk', async () => {
    await writeSession(sample)
    const round = await readSession()
    expect(round).toEqual(sample)
  })

  it('writes the session.json file with mode 0600', async () => {
    await writeSession(sample)
    const stats = statSync(sessionFilePath())
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('overwrites an existing session', async () => {
    await writeSession(sample)
    const next: SessionState = { ...sample, accessToken: 'new-access-jwt' }
    await writeSession(next)
    expect((await readSession()).accessToken).toBe('new-access-jwt')
  })

  it('round-trips a session without optional fields (idToken, machineLabel)', async () => {
    const minimal: SessionState = {
      version: 2,
      accessToken: 'tok',
      accessTokenExpiry: 1_000_000,
      refreshToken: 'rt',
      frontendApiUrl: 'https://t.clerk.accounts.dev',
      clientId: 'client_abc',
      convexUrl: 'https://x.convex.cloud',
    }
    await writeSession(minimal)
    const round = await readSession()
    expect(round).toEqual(minimal)
    expect(round.idToken).toBeUndefined()
    expect(round.machineLabel).toBeUndefined()
  })
})

describe('readSession when not logged in', () => {
  it('throws NotLoggedInError when session.json does not exist', async () => {
    await expect(readSession()).rejects.toBeInstanceOf(NotLoggedInError)
  })
})

describe('readSession with v1 (Clerk-ticket) session', () => {
  it('rejects a version:1 blob with NotLoggedInError (forces re-login via OAuth)', async () => {
    const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs')
    mkdirSync(join(tempHome, '.vault'), { recursive: true })
    chmodSync(join(tempHome, '.vault'), 0o700)
    const v1Blob = {
      version: 1,
      clerkSessionId: 'sess_old',
      clerkSessionToken: 'old-token',
      convexJwt: 'old-convex-jwt',
      convexJwtExpiry: 1_700_000_060,
      frontendApiUrl: 'https://clear-redbird-6.clerk.accounts.dev',
      convexUrl: 'https://beloved-mouse-707.convex.cloud',
      issuedAt: 1_700_000_000,
    }
    writeFileSync(sessionFilePath(), JSON.stringify(v1Blob))
    chmodSync(sessionFilePath(), 0o600)
    await expect(readSession()).rejects.toBeInstanceOf(NotLoggedInError)
  })

  it('rejects a blob with no version field with NotLoggedInError', async () => {
    const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs')
    mkdirSync(join(tempHome, '.vault'), { recursive: true })
    chmodSync(join(tempHome, '.vault'), 0o700)
    writeFileSync(sessionFilePath(), JSON.stringify({ clerkSessionId: 'sess_x' }))
    chmodSync(sessionFilePath(), 0o600)
    await expect(readSession()).rejects.toBeInstanceOf(NotLoggedInError)
  })
})

describe('readSession with corrupt content', () => {
  it('throws a clear error if session.json is not valid JSON', async () => {
    const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs')
    mkdirSync(join(tempHome, '.vault'), { recursive: true })
    chmodSync(join(tempHome, '.vault'), 0o700)
    writeFileSync(sessionFilePath(), 'not json')
    chmodSync(sessionFilePath(), 0o600)
    await expect(readSession()).rejects.toThrow(/parse session/i)
  })
})

describe('readSession with loose perms', () => {
  it('rejects via paths.readSecret when session.json mode is 0644', async () => {
    const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs')
    mkdirSync(join(tempHome, '.vault'), { recursive: true })
    chmodSync(join(tempHome, '.vault'), 0o700)
    writeFileSync(sessionFilePath(), JSON.stringify(sample))
    chmodSync(sessionFilePath(), 0o644)
    await expect(readSession()).rejects.toThrow(/perm/i)
  })
})
