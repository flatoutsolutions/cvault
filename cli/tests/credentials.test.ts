/**
 * Tests for the credentials façade (`src/credentials.ts`).
 *
 * The façade is a thin wrapper over the native primitives in
 * `cli/src/native/`. It preserves the legacy claude-swap verb names
 * (`exportAccount`, `importEnvelope`, `switchTo`, …) so command files +
 * scenario tests keep working without per-file rewrites. Unit tests for
 * the native primitives themselves live under `tests/native/`. These
 * tests pin the façade's translation layer:
 *
 *  - `exportAccount(any)` builds an envelope from the active credentials
 *  - `importEnvelope(env)` writes the credentials + claude.json slice
 *  - `switchTo(any)` is a no-op (active = whatever was last imported)
 *  - `removeAccount(any)` clears keychain + claude.json
 *  - `purge()` clears keychain + claude.json
 *  - `status()` synthesizes the legacy "Status: Account-N (email)" string
 *    from the active oauthAccount slice
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  exportAccount,
  exportAll,
  getActiveAccount,
  importEnvelope,
  purge,
  removeAccount,
  status,
  switchTo,
} from '../src/credentials'
import { deleteActiveCredentials, readActiveCredentials, writeActiveCredentials } from '../src/native/keychain'
import { singleAccountEnvelope } from './fixtures/envelopes/singleAccount'

vi.mock('../src/native/keychain', () => ({
  KEYCHAIN_SERVICE: 'Claude Code-credentials',
  readActiveCredentials: vi.fn(),
  writeActiveCredentials: vi.fn(),
  deleteActiveCredentials: vi.fn(),
}))

let tempHome: string
let originalPlatform: NodeJS.Platform
let configPath: string

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-claudeswap-shim-test-'))
  vi.stubEnv('HOME', tempHome)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  configPath = join(tempHome, '.claude.json')
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  rmSync(tempHome, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

const KEYCHAIN_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA',
    refreshToken: 'sk-ant-ort01-BBBBBBBBBBBBBBBBBBBB',
    expiresAt: 1_900_000_000_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
  },
})

const CLAUDE_OAUTH = {
  emailAddress: 'a@b.com',
  accountUuid: '11111111-1111-1111-1111-111111111111',
  organizationUuid: '22222222-2222-2222-2222-222222222222',
  organizationName: 'Test Org',
}

function seedActive(): void {
  vi.mocked(readActiveCredentials).mockReturnValue(KEYCHAIN_BLOB)
  writeFileSync(configPath, JSON.stringify({ oauthAccount: CLAUDE_OAUTH }), { mode: 0o600 })
}

describe('exportAccount (shim)', () => {
  it('builds an envelope from active credentials, ignoring slotOrEmail arg', () => {
    seedActive()
    const env = exportAccount(99) // slot is intentionally ignored on native
    expect(env.version).toBe(1)
    expect(env.encrypted).toBe(false)
    // Always slot 1 on native — only one active account.
    expect(env.activeAccountNumber).toBe(1)
    const acc = env.accounts[0]!
    expect(acc.email).toBe('a@b.com')
    expect(acc.credentials.claudeAiOauth.accessToken).toBe('sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA')
  })

  it('accepts an email argument (still ignored)', () => {
    seedActive()
    const env = exportAccount('user@example.com')
    expect(env.accounts[0]!.email).toBe('a@b.com')
  })
})

describe('exportAll (shim)', () => {
  it('returns the same single-account envelope as exportAccount on native', () => {
    seedActive()
    const env = exportAll()
    expect(env.accounts).toHaveLength(1)
  })
})

describe('importEnvelope (shim)', () => {
  it('writes both the keychain blob and the oauthAccount slice', async () => {
    const env = singleAccountEnvelope()
    await importEnvelope(env)
    expect(writeActiveCredentials).toHaveBeenCalledOnce()
    const blobArg = vi.mocked(writeActiveCredentials).mock.calls[0]?.[0] ?? ''
    const parsed = JSON.parse(blobArg) as { claudeAiOauth: { accessToken: string } }
    expect(parsed.claudeAiOauth.accessToken).toBe(env.accounts[0]!.credentials.claudeAiOauth.accessToken)
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(onDisk.oauthAccount).toEqual(env.accounts[0]!.config?.oauthAccount)
  })

  it('ignores the `force` flag (always overwrites)', async () => {
    await importEnvelope(singleAccountEnvelope(), true)
    expect(writeActiveCredentials).toHaveBeenCalledOnce()
  })
})

describe('switchTo (shim)', () => {
  it('is a no-op (does not touch credentials store)', () => {
    switchTo(2)
    switchTo('user@example.com')
    expect(writeActiveCredentials).not.toHaveBeenCalled()
    expect(readActiveCredentials).not.toHaveBeenCalled()
    expect(deleteActiveCredentials).not.toHaveBeenCalled()
  })
})

describe('removeAccount (shim)', () => {
  it('clears the active credentials AND the oauthAccount slice', async () => {
    writeFileSync(configPath, JSON.stringify({ oauthAccount: CLAUDE_OAUTH, somethingElse: 'keep' }), { mode: 0o600 })
    await removeAccount('a@b.com')
    expect(deleteActiveCredentials).toHaveBeenCalledOnce()
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(onDisk.oauthAccount).toBeUndefined()
    // sibling keys preserved
    expect(onDisk.somethingElse).toBe('keep')
  })
})

describe('purge (shim)', () => {
  it('behaves identically to removeAccount on native', async () => {
    writeFileSync(configPath, JSON.stringify({ oauthAccount: CLAUDE_OAUTH }), { mode: 0o600 })
    await purge()
    expect(deleteActiveCredentials).toHaveBeenCalledOnce()
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(onDisk.oauthAccount).toBeUndefined()
  })
})

describe('getActiveAccount', () => {
  it('returns a typed view of the active account', () => {
    seedActive()
    const active = getActiveAccount()
    expect(active).toEqual({
      email: 'a@b.com',
      organizationName: 'Test Org',
      organizationUuid: '22222222-2222-2222-2222-222222222222',
      accountUuid: '11111111-1111-1111-1111-111111111111',
    })
  })

  it('returns null when keychain has no credentials', () => {
    vi.mocked(readActiveCredentials).mockReturnValueOnce(null)
    expect(getActiveAccount()).toBeNull()
  })

  it('returns null when ~/.claude.json has no oauthAccount.emailAddress', () => {
    vi.mocked(readActiveCredentials).mockReturnValueOnce(KEYCHAIN_BLOB)
    expect(getActiveAccount()).toBeNull()
  })

  it('omits org/uuid fields that are absent', () => {
    vi.mocked(readActiveCredentials).mockReturnValueOnce(KEYCHAIN_BLOB)
    writeFileSync(configPath, JSON.stringify({ oauthAccount: { emailAddress: 'minimal@x.com' } }), { mode: 0o600 })
    expect(getActiveAccount()).toEqual({ email: 'minimal@x.com' })
  })
})

describe('status (shim)', () => {
  it('returns "Status: Account-1 (email [org])" when an active account exists', () => {
    seedActive()
    const out = status()
    expect(out).toContain('Status: Account-1')
    expect(out).toContain('a@b.com')
    expect(out).toContain('Test Org')
  })

  it('returns "No active account" when keychain has no credentials', () => {
    vi.mocked(readActiveCredentials).mockReturnValueOnce(null)
    expect(status()).toMatch(/no active account/i)
  })

  it('returns "No active account" when ~/.claude.json has no oauthAccount.emailAddress', () => {
    vi.mocked(readActiveCredentials).mockReturnValueOnce(KEYCHAIN_BLOB)
    // No file at all → no email
    expect(status()).toMatch(/no active account/i)
  })

  it('omits the [org] suffix when organizationName is empty', () => {
    vi.mocked(readActiveCredentials).mockReturnValueOnce(KEYCHAIN_BLOB)
    writeFileSync(configPath, JSON.stringify({ oauthAccount: { emailAddress: 'noorg@x.com' } }), { mode: 0o600 })
    const out = status()
    expect(out).toContain('noorg@x.com')
    expect(out).not.toContain('[')
  })
})
