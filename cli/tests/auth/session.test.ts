/**
 * Spec: §6, §7 — durable Clerk session storage on disk.
 *
 * Each test gets a fresh tmp HOME. The actual perm + atomic-write logic
 * lives in `paths.ts`, so this file pins the session-shape contract and
 * the wiring from `readSession`/`writeSession` to those primitives.
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
  version: 1,
  clerkSessionId: 'sess_abc',
  clerkSessionToken: 'session-jwt',
  convexJwt: 'convex-jwt',
  convexJwtExpiry: 1_700_000_060,
  frontendApiUrl: 'https://clear-redbird-6.clerk.accounts.dev',
  convexUrl: 'https://beloved-mouse-707.convex.cloud',
  issuedAt: 1_700_000_000,
}

describe('sessionFilePath', () => {
  it('returns ~/.vault/session.json', () => {
    expect(sessionFilePath()).toBe(join(tempHome, '.vault', 'session.json'))
  })
})

describe('writeSession + readSession', () => {
  it('round-trips a session through the disk', async () => {
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
    const next: SessionState = { ...sample, clerkSessionId: 'sess_new' }
    await writeSession(next)
    expect((await readSession()).clerkSessionId).toBe('sess_new')
  })
})

describe('readSession when not logged in', () => {
  it('throws NotLoggedInError when session.json does not exist', async () => {
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
