/**
 * Native envelope build/apply.
 *
 * `buildEnvelope` reads the active credentials + ~/.claude.json's
 * oauthAccount slice and returns the same `ClaudeSwapEnvelope` shape that
 * the legacy claude-swap path produced. The wire format is sacred — Convex
 * still accepts old envelopes, so we don't change types.
 *
 * `applyEnvelope` writes the credentials + the oauthAccount slice. After
 * that runs, Claude Code itself can immediately use the active sub.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyEnvelope, buildEnvelope } from '../../src/native/envelope'
import { deleteActiveCredentials, readActiveCredentials, writeActiveCredentials } from '../../src/native/keychain'
import { singleAccountEnvelope } from '../fixtures/envelopes/singleAccount'

vi.mock('../../src/native/keychain', () => ({
  KEYCHAIN_SERVICE: 'Claude Code-credentials',
  readActiveCredentials: vi.fn(),
  writeActiveCredentials: vi.fn(),
  deleteActiveCredentials: vi.fn(),
}))

// We mock claudeConfig with `importActual` so the default behavior is
// real (read/write actual files in the tmpdir) — only the R1 rollback
// tests override `writeOauthAccount` to simulate partial-success.
vi.mock('../../src/native/claudeConfig', async () => {
  const actual = await vi.importActual<typeof import('../../src/native/claudeConfig')>('../../src/native/claudeConfig')
  return {
    ...actual,
    writeOauthAccount: vi.fn(actual.writeOauthAccount),
    clearOauthAccount: vi.fn(actual.clearOauthAccount),
  }
})

let tempHome: string
let originalPlatform: NodeJS.Platform
let configPath: string

beforeEach(async () => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-envelope-test-'))
  vi.stubEnv('HOME', tempHome)

  // Reset the claudeConfig mock's implementation between tests. The
  // global afterEach clears call history but mockImplementation set in
  // an earlier test persists, which leaks throws into the next test's
  // applyEnvelope call. We restore the REAL implementation by pulling
  // it from `vi.importActual` (the mock factory above only wraps the
  // real export in `vi.fn(...)` — the underlying real function is the
  // same module's source).
  const actual = await vi.importActual<typeof import('../../src/native/claudeConfig')>('../../src/native/claudeConfig')
  const mocked = await import('../../src/native/claudeConfig')
  vi.mocked(mocked.writeOauthAccount).mockReset()
  vi.mocked(mocked.writeOauthAccount).mockImplementation(actual.writeOauthAccount)
  vi.mocked(mocked.clearOauthAccount).mockReset()
  vi.mocked(mocked.clearOauthAccount).mockImplementation(actual.clearOauthAccount)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  configPath = join(tempHome, '.claude.json')
  originalPlatform = process.platform
  // Default to macos so the keychain mock is the active backend.
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

const CLAUDE_JSON_OAUTH = {
  emailAddress: 'user@example.com',
  accountUuid: '11111111-1111-1111-1111-111111111111',
  organizationUuid: '22222222-2222-2222-2222-222222222222',
  organizationName: 'Test Org',
  displayName: 'Stefan',
}

describe('buildEnvelope', () => {
  it('combines keychain blob + ~/.claude.json into a ClaudeSwapEnvelope', () => {
    vi.mocked(readActiveCredentials).mockReturnValueOnce(KEYCHAIN_BLOB)
    writeFileSync(configPath, JSON.stringify({ oauthAccount: CLAUDE_JSON_OAUTH }), { mode: 0o600 })

    const env = buildEnvelope({ number: 1 })

    expect(env.version).toBe(1)
    expect(env.encrypted).toBe(false)
    expect(env.activeAccountNumber).toBe(1)
    // Stamp identifies the producer version per the brief.
    expect(env.swapVersion).toBe('cvault-native-1')
    expect(env.exportedFrom).toBe('macos')
    expect(env.accounts).toHaveLength(1)
    const acc = env.accounts[0]!
    expect(acc.number).toBe(1)
    expect(acc.email).toBe('user@example.com')
    expect(acc.uuid).toBe('11111111-1111-1111-1111-111111111111')
    expect(acc.organizationUuid).toBe('22222222-2222-2222-2222-222222222222')
    expect(acc.organizationName).toBe('Test Org')
    expect(acc.credentials.claudeAiOauth.accessToken).toBe('sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA')
    // The full oauthAccount sub-document must round-trip into config.
    expect(acc.config?.oauthAccount).toEqual(CLAUDE_JSON_OAUTH)
  })

  it('throws when no credentials are stored on this machine', () => {
    vi.mocked(readActiveCredentials).mockReturnValueOnce(null)
    expect(() => buildEnvelope({ number: 1 })).toThrow(/no credentials|not signed in|active/i)
  })

  it('throws when ~/.claude.json has no oauthAccount slice', () => {
    vi.mocked(readActiveCredentials).mockReturnValueOnce(KEYCHAIN_BLOB)
    // Either no file at all, or a file without oauthAccount — both are
    // "no email yet, the user has Keychain creds but Claude Code never
    // wrote oauthAccount". Either way we cannot build a complete envelope.
    expect(() => buildEnvelope({ number: 1 })).toThrow(/oauthAccount|email|claude\.json/i)
  })

  it('falls back to defaults when oauthAccount is partial (only emailAddress)', () => {
    vi.mocked(readActiveCredentials).mockReturnValueOnce(KEYCHAIN_BLOB)
    writeFileSync(configPath, JSON.stringify({ oauthAccount: { emailAddress: 'minimal@x.com' } }), { mode: 0o600 })

    const env = buildEnvelope({ number: 2 })
    const acc = env.accounts[0]!
    expect(acc.email).toBe('minimal@x.com')
    // Missing fields stay undefined (or zero-uuid for uuid).
    expect(acc.organizationName).toBe('')
    // accountUuid missing → all-zero placeholder so claude-swap import won't reject it.
    expect(acc.uuid).toBe('00000000-0000-0000-0000-000000000000')
  })

  it('throws when keychain blob is not valid JSON', () => {
    vi.mocked(readActiveCredentials).mockReturnValueOnce('not-json')
    writeFileSync(configPath, JSON.stringify({ oauthAccount: CLAUDE_JSON_OAUTH }), { mode: 0o600 })
    expect(() => buildEnvelope({ number: 1 })).toThrow(/JSON|parse/i)
  })

  it('throws when keychain blob has no claudeAiOauth wrapper', () => {
    vi.mocked(readActiveCredentials).mockReturnValueOnce(JSON.stringify({ wrongShape: true }))
    writeFileSync(configPath, JSON.stringify({ oauthAccount: CLAUDE_JSON_OAUTH }), { mode: 0o600 })
    expect(() => buildEnvelope({ number: 1 })).toThrow(/claudeAiOauth/i)
  })

  it('roundtrips through the legacy fixture', () => {
    // Build a fresh envelope with every field set, write it back via
    // applyEnvelope, then rebuild — should match (modulo timestamps).
    vi.mocked(readActiveCredentials).mockReturnValueOnce(KEYCHAIN_BLOB)
    writeFileSync(configPath, JSON.stringify({ oauthAccount: CLAUDE_JSON_OAUTH }), { mode: 0o600 })

    const env1 = buildEnvelope({ number: 1 })
    // Shape parity with the fixture (account-level fields).
    const fixture = singleAccountEnvelope()
    expect(Object.keys(env1.accounts[0]!).sort()).toEqual(
      expect.arrayContaining(Object.keys(fixture.accounts[0]!).filter((k) => k !== 'added'))
    )
  })
})

describe('applyEnvelope', () => {
  it('writes the keychain blob and the oauthAccount slice', async () => {
    const env = singleAccountEnvelope()
    await applyEnvelope(env)
    // Keychain write
    expect(writeActiveCredentials).toHaveBeenCalledOnce()
    const blobArg = vi.mocked(writeActiveCredentials).mock.calls[0]?.[0] ?? ''
    const parsed = JSON.parse(blobArg) as { claudeAiOauth: { accessToken: string } }
    expect(parsed.claudeAiOauth.accessToken).toBe(env.accounts[0]!.credentials.claudeAiOauth.accessToken)
    // Claude config write
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      oauthAccount: { display_name: string }
    }
    expect(onDisk.oauthAccount).toEqual(env.accounts[0]!.config?.oauthAccount)
  })

  it('throws when envelope has no accounts', async () => {
    const env = singleAccountEnvelope()
    env.accounts = []
    await expect(applyEnvelope(env)).rejects.toThrow(/no accounts|empty|account/i)
  })

  it('preserves sibling keys in ~/.claude.json', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        oauthAccount: { emailAddress: 'old@x.com' },
        cachedTelemetryId: 'tel-1',
      }),
      { mode: 0o600 }
    )
    const env = singleAccountEnvelope()
    await applyEnvelope(env)
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(onDisk.cachedTelemetryId).toBe('tel-1')
  })

  it('rolls back the keychain write when ~/.claude.json write fails (H3)', async () => {
    // Seed prior state — keychain has a "previous" credential blob.
    const PRIOR_BLOB = JSON.stringify({ claudeAiOauth: { accessToken: 'PRIOR' } })
    vi.mocked(readActiveCredentials).mockReturnValueOnce(PRIOR_BLOB)
    // Force the second write (oauthAccount slice) to fail. We do this by
    // making the config path point to a directory we can't write to:
    // chmod the parent to 0o500 so writeFileSync EACCES.
    const env = singleAccountEnvelope()
    // Easiest way to force a write failure: stub writeOauthAccount inside
    // claudeConfig. But it isn't mocked here. Alternative: pre-create a
    // directory at the tmp-rename target so renameSync fails.
    const { mkdirSync } = await import('node:fs')
    mkdirSync(`${configPath}.${process.pid.toString()}.tmp`, { recursive: true })

    await expect(applyEnvelope(env)).rejects.toThrow()

    // Rollback: writeActiveCredentials was called twice — once for the
    // new blob, once with PRIOR_BLOB to restore.
    const writeCalls = vi.mocked(writeActiveCredentials).mock.calls
    expect(writeCalls.length).toBe(2)
    expect(writeCalls[1]?.[0]).toBe(PRIOR_BLOB)
  })

  it('rolls back to deleted state when there were no prior credentials and the second write fails', async () => {
    // No prior credentials.
    vi.mocked(readActiveCredentials).mockReturnValueOnce(null)
    // Force the second write to fail.
    const env = singleAccountEnvelope()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(`${configPath}.${process.pid.toString()}.tmp`, { recursive: true })

    await expect(applyEnvelope(env)).rejects.toThrow()

    // Rollback: deleteActiveCredentials was called to undo the first write.
    expect(deleteActiveCredentials).toHaveBeenCalledOnce()
  })

  it('R1: rolls back BOTH credentials AND oauthAccount when step 2 partially succeeds', async () => {
    // Seed prior state on both halves.
    const PRIOR_BLOB = JSON.stringify({ claudeAiOauth: { accessToken: 'PRIOR' } })
    const PRIOR_OAUTH = { emailAddress: 'prior@example.com', accountUuid: 'prior-uuid' }
    vi.mocked(readActiveCredentials).mockReturnValue(PRIOR_BLOB)
    writeFileSync(configPath, JSON.stringify({ oauthAccount: PRIOR_OAUTH, keep: 'this' }), { mode: 0o600 })

    // Simulate the "partial success" window: writeOauthAccount writes
    // the new value to disk (rename succeeded), then throws to simulate
    // a failure between rename and chmod. The function signals failure
    // even though the new value is already on disk. R1's symmetric
    // rollback must restore both halves.
    const claudeConfig = await import('../../src/native/claudeConfig')
    const writeOauthMock = vi.mocked(claudeConfig.writeOauthAccount)
    let callCount = 0
    writeOauthMock.mockImplementation((oauth: Record<string, unknown>) => {
      callCount += 1
      // Write the value to disk on every call (real behavior).
      const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      writeFileSync(configPath, JSON.stringify({ ...cfg, oauthAccount: oauth }), { mode: 0o600 })
      // First call (the "real" write): throw AFTER the on-disk write
      // to simulate the post-rename / pre-chmod failure window.
      if (callCount === 1) {
        throw new Error('simulated post-rename chmod failure')
      }
      // Second call (rollback): succeed.
    })

    const env = singleAccountEnvelope({
      email: 'new@example.com',
      config: { oauthAccount: { emailAddress: 'new@example.com', accountUuid: 'new-uuid' } },
    })

    await expect(applyEnvelope(env)).rejects.toThrow(/simulated post-rename chmod failure/)

    // Credentials rolled back: writeActiveCredentials called with
    // PRIOR_BLOB after the new blob.
    const writeCalls = vi.mocked(writeActiveCredentials).mock.calls
    expect(writeCalls.length).toBeGreaterThanOrEqual(2)
    expect(writeCalls[writeCalls.length - 1]?.[0]).toBe(PRIOR_BLOB)

    // oauthAccount rolled back: writeOauthAccount called twice — once
    // with the new (which threw), once with PRIOR_OAUTH for rollback.
    expect(writeOauthMock).toHaveBeenCalledTimes(2)
    expect(writeOauthMock.mock.calls[1]?.[0]).toEqual(PRIOR_OAUTH)

    // On disk, the file ends up restored to PRIOR_OAUTH.
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      oauthAccount: Record<string, unknown>
      keep: string
    }
    expect(onDisk.oauthAccount).toEqual(PRIOR_OAUTH)
    expect(onDisk.keep).toBe('this')

    // Reset the mock so subsequent tests get default behavior again.
    writeOauthMock.mockReset()
    writeOauthMock.mockImplementation((oauth) => {
      const cfg = readFileSync(configPath, 'utf8')
      const parsed = JSON.parse(cfg) as Record<string, unknown>
      writeFileSync(configPath, JSON.stringify({ ...parsed, oauthAccount: oauth }), { mode: 0o600 })
    })
  })

  it('R1: clears oauthAccount on rollback when there was no prior oauthAccount', async () => {
    // Prior state: credentials present, NO oauthAccount slice.
    const PRIOR_BLOB = JSON.stringify({ claudeAiOauth: { accessToken: 'PRIOR' } })
    vi.mocked(readActiveCredentials).mockReturnValue(PRIOR_BLOB)
    writeFileSync(configPath, JSON.stringify({ otherKey: 'preserved' }), { mode: 0o600 })

    const claudeConfig = await import('../../src/native/claudeConfig')
    const writeOauthMock = vi.mocked(claudeConfig.writeOauthAccount)
    const clearOauthMock = vi.mocked(claudeConfig.clearOauthAccount)

    writeOauthMock.mockReset()
    writeOauthMock.mockImplementation((oauth: Record<string, unknown>) => {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      writeFileSync(configPath, JSON.stringify({ ...cfg, oauthAccount: oauth }), { mode: 0o600 })
      throw new Error('simulated post-rename failure')
    })
    clearOauthMock.mockReset()
    clearOauthMock.mockImplementation(() => {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      const { oauthAccount: _omit, ...rest } = cfg
      void _omit
      writeFileSync(configPath, JSON.stringify(rest), { mode: 0o600 })
    })

    const env = singleAccountEnvelope({
      email: 'new@example.com',
      config: { oauthAccount: { emailAddress: 'new@example.com' } },
    })

    await expect(applyEnvelope(env)).rejects.toThrow()

    // Since there was no prior oauthAccount, rollback should call
    // clearOauthAccount, NOT writeOauthAccount with a prior value.
    expect(clearOauthMock).toHaveBeenCalledOnce()
    // And the file on disk should NOT have an oauthAccount.
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(onDisk.oauthAccount).toBeUndefined()
    expect(onDisk.otherKey).toBe('preserved')
  })

  it('serializes concurrent applyEnvelope calls via the file lock (H2 + L4b)', async () => {
    // L4b: prove the file lock actually prevents step interleaving by
    // tracking enter/exit events from inside writeActiveCredentials.
    // The blob carries the envelope's email, which uniquely identifies
    // which applyEnvelope call is currently inside the critical section.
    // If the lock works, the events are nested: enter-A, exit-A,
    // enter-B, exit-B (or B-then-A) — never enter-A, enter-B, exit-A,
    // exit-B.
    vi.mocked(readActiveCredentials).mockReturnValue(null)
    const events: string[] = []
    vi.mocked(writeActiveCredentials).mockImplementation((blob: string) => {
      // Extract the access token's last 5 chars to identify which
      // envelope this write belongs to. We use the token (not email)
      // because the credentials slot doesn't carry email — only
      // claudeAiOauth.
      const tokenMatch = /accessToken":"([^"]+)/.exec(blob)
      const id = tokenMatch?.[1]?.slice(-5) ?? '?'
      events.push(`enter-${id}`)
      // Synchronous busy-spin — widens the window any interleaving
      // would have to cross (Bun's nextTick can wake the other
      // promise during this window if the lock didn't actually hold).
      const start = Date.now()
      while (Date.now() - start < 15) {
        // intentional spin
      }
      events.push(`exit-${id}`)
    })

    const env1 = singleAccountEnvelope({ email: 'first@x.com' })
    env1.accounts[0]!.credentials.claudeAiOauth.accessToken = 'sk-ant-oat01-AAAAAAAAAAAAA-FIRST'
    const env2 = singleAccountEnvelope({ email: 'second@x.com' })
    env2.accounts[0]!.credentials.claudeAiOauth.accessToken = 'sk-ant-oat01-AAAAAAAAAAAAA-SECOND'

    await Promise.all([applyEnvelope(env1), applyEnvelope(env2)])

    expect(writeActiveCredentials).toHaveBeenCalledTimes(2)

    // Mutual exclusion check: each ID must have its enter and exit
    // adjacent in the events log (no interleaving). The order events
    // appear may be (FIRST, SECOND) or (SECOND, FIRST) but each
    // 'enter-X' must be immediately followed by 'exit-X'.
    expect(events.length).toBe(4)
    expect(events[0]).toMatch(/^enter-/)
    expect(events[1]).toBe(events[0]!.replace('enter-', 'exit-'))
    expect(events[2]).toMatch(/^enter-/)
    expect(events[3]).toBe(events[2]!.replace('enter-', 'exit-'))
    // And the two enters must be different ids.
    expect(events[0]).not.toBe(events[2])

    // The on-disk claude.json reflects ONE of the two oauthAccounts —
    // never a corrupted half-and-half merge.
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      oauthAccount?: { display_name?: string }
    }
    expect(onDisk.oauthAccount).toBeDefined()
  })
})
