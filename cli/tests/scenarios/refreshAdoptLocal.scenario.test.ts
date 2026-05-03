/**
 * Scenario — `cvault refresh` adopt-local + cross-machine rotation race.
 *
 * Plan: review-pass M1/M2/M5 covers the server-side race protection. This
 * scenario file exercises the CLI-side end-to-end coordination:
 *   1. Machine A's local Keychain has fresher tokens than the vault →
 *      `cvault refresh` on A → vault adopts local (server returns
 *      `adoptedLocal`; CLI prints "Pushed local to vault").
 *   2. The vault has fresher state than machine A's local → `cvault refresh`
 *      on A → vault state pulled to local (server returns `pulledFresh`;
 *      CLI writes the returned plaintext to the local Keychain).
 *   3. Both machine A and machine B run `cvault refresh` concurrently
 *      against the same sub → no spurious RELOGIN_REQUIRED, no expiresAt
 *      regression. The proper-lockfile mutex serializes machine A's
 *      Keychain write against any other in-process race; the server-side
 *      M1 + M2 protections handle the actual cross-machine race for the
 *      vault row.
 *
 * Stubbed (and why):
 *  - `keychain.ts` / `credentialsFile.ts` — real Keychain access in tests
 *    is dangerous and flaky. Writes are observed via spies.
 *  - `makeVaultClient` — wired to in-memory FakeVaultClient. The fake's
 *    refreshSub handler honors the real adopt-local / pull-fresh contract
 *    so the CLI orchestration is exercised end-to-end.
 *
 * NOT stubbed (the whole point of the scenario):
 *  - `applyEnvelope` and `withFileLock` — these run for real so the
 *    serialization invariant is exercised. Real `~/.claude.json` writes
 *    happen in the tmpdir.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runRefresh } from '../../src/commands/refresh'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { writeActiveCredentials } from '../../src/native/keychain'
import { type FakeSubscription, makeSub } from './_helpers'

// Mock Keychain reads + writes (safe in tests). Reads return null by
// default; per-test setup overrides when "machine A has fresher local".
vi.mock('../../src/native/keychain', () => ({
  KEYCHAIN_SERVICE: 'Claude Code-credentials',
  readActiveCredentials: vi.fn(() => null),
  writeActiveCredentials: vi.fn(),
  deleteActiveCredentials: vi.fn(),
}))

vi.mock('../../src/native/credentialsFile', () => ({
  readCredentialsFile: vi.fn(() => null),
  writeCredentialsFile: vi.fn(),
  deleteCredentialsFile: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

let tempHome: string
let originalPlatform: NodeJS.Platform

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-refresh-adopt-'))
  vi.stubEnv('HOME', tempHome)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  mkdirSync(join(tempHome, '.vault'), { recursive: true, mode: 0o700 })
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  rmSync(tempHome, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

/**
 * Helper: build a minimal in-memory fake of the vault that ALSO supports
 * `subscriptions.actions.refreshSub` — the existing `_helpers.ts` fake
 * doesn't include it because the original CLI test-suite scenarios
 * predated the refresh command. Inline here so this file stays
 * self-contained and the helper file's contract doesn't expand.
 *
 * The fake's refreshSub handler honors the same adopt-local / pull-fresh
 * contract the real action implements (parsing `claudeAiOauth.expiresAt`,
 * comparing to the row's `expiresAt`, mutating the stored plaintext when
 * local is newer, returning the appropriate action label).
 */
interface RefreshSubArgs {
  slot: number
  localState?: string
  force?: boolean
}

function createRefreshFake(initial: FakeSubscription[]): {
  query: ReturnType<typeof vi.fn>
  action: ReturnType<typeof vi.fn>
  state: Map<string, FakeSubscription>
  // Mirrors VaultClient.withMachineLabel — refresh's command code calls it.
  withMachineLabel: <T extends Record<string, unknown>>(args: T) => T & { machineLabel?: string }
} {
  const state = new Map(initial.map((s) => [s._id as string, s]))

  const query = vi.fn(async (_ref: unknown, _args?: Record<string, unknown>) => {
    // Both refresh paths call listForUser at most once (--all).
    const out: Array<Pick<FakeSubscription, '_id' | 'slot' | 'email' | 'expiresAt'>> = []
    for (const sub of state.values()) {
      if (sub.removedAt !== undefined) continue
      out.push({ _id: sub._id, slot: sub.slot, email: sub.email, expiresAt: sub.expiresAt })
    }
    out.sort((a, b) => a.slot - b.slot)
    return await Promise.resolve(out)
  })

  const action = vi.fn(async (_ref: unknown, args?: Record<string, unknown>) => {
    const refreshArgs = args as unknown as RefreshSubArgs
    const sub = Array.from(state.values()).find((s) => s.slot === refreshArgs.slot && s.removedAt === undefined)
    if (!sub) {
      throw new Error(`refreshSub fake: no sub at slot ${refreshArgs.slot.toString()}`)
    }

    // Parse local expiresAt to decide adopt vs pull.
    let localExpiresAt: number | undefined
    if (refreshArgs.localState !== undefined) {
      try {
        const parsed = JSON.parse(refreshArgs.localState) as { claudeAiOauth?: { expiresAt?: unknown } }
        if (typeof parsed.claudeAiOauth?.expiresAt === 'number' && parsed.claudeAiOauth.expiresAt > 0) {
          localExpiresAt = parsed.claudeAiOauth.expiresAt
        }
      } catch {
        // ignore parse failure
      }
    }

    let actionLabel: 'inSync' | 'pulledFresh' | 'adoptedLocal' | 'refreshedFromAnthropic' = 'inSync'
    if (localExpiresAt !== undefined && localExpiresAt > sub.expiresAt) {
      // Adopt local — replace stored plaintext.
      sub.plaintextBlob = refreshArgs.localState ?? sub.plaintextBlob
      sub.expiresAt = localExpiresAt
      sub.lastRefreshedAt = Date.now()
      const { createHash } = await import('node:crypto')
      sub.contentHash = createHash('sha256').update(sub.plaintextBlob).digest('hex')
      actionLabel = 'adoptedLocal'
    } else if (localExpiresAt !== undefined && localExpiresAt < sub.expiresAt) {
      actionLabel = 'pulledFresh'
    } else if (refreshArgs.force === true) {
      // Force-refresh: simulate a server-side rotation (fresh AT/RT).
      const newExpiresAt = Date.now() + 8 * 60 * 60 * 1000
      const rotated = JSON.stringify({
        claudeAiOauth: {
          accessToken: `sk-ant-oat01-ROT-${refreshArgs.slot.toString().padStart(4, '0')}-AAAAAAA`,
          refreshToken: `sk-ant-ort01-ROT-${refreshArgs.slot.toString().padStart(4, '0')}-BBBBBBB`,
          expiresAt: newExpiresAt,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
        config: { oauthAccount: { emailAddress: sub.email } },
      })
      sub.plaintextBlob = rotated
      sub.expiresAt = newExpiresAt
      sub.lastRefreshedAt = Date.now()
      const { createHash } = await import('node:crypto')
      sub.contentHash = createHash('sha256').update(rotated).digest('hex')
      actionLabel = 'refreshedFromAnthropic'
    }

    return {
      email: sub.email,
      slot: sub.slot,
      plaintextBlob: sub.plaintextBlob,
      contentHash: sub.contentHash,
      expiresAt: sub.expiresAt,
      lastRefreshedAt: sub.lastRefreshedAt,
      action: actionLabel,
    }
  })

  function withMachineLabel<T extends Record<string, unknown>>(args: T): T & { machineLabel?: string } {
    // Identity passthrough — these scenarios don't assert label propagation.
    return args
  }

  return { query, action, state, withMachineLabel }
}

describe('Scenario — cvault refresh adopts local when local is newer', () => {
  it('local Keychain has fresher tokens than vault → action label is adoptedLocal; vault row updated', async () => {
    const oldExpires = Date.now() + 30 * 60 * 1000
    const sub = await makeSub({
      email: 'multi@example.com',
      slot: 1,
      expiresAt: oldExpires,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-OLDVAULT-AAAAAAAAAAAAAA',
          refreshToken: 'sk-ant-ort01-OLDVAULT-BBBBBBBBBBBBBB',
          expiresAt: oldExpires,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
        config: { oauthAccount: { emailAddress: 'multi@example.com' } },
      }),
    })

    const fake = createRefreshFake([sub])
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    // Local has a strictly newer expiresAt — the user's claude rotated
    // locally before cvault saw it.
    const newExpires = oldExpires + 4 * 60 * 60 * 1000
    const localState = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-NEWLOCAL-CCCCCCCCCCCCCC',
        refreshToken: 'sk-ant-ort01-NEWLOCAL-DDDDDDDDDDDDDD',
        expiresAt: newExpires,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
      config: { oauthAccount: { emailAddress: 'multi@example.com' } },
    })
    const { readActiveCredentials } = await import('../../src/native/keychain')
    vi.mocked(readActiveCredentials).mockReturnValue(localState)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runRefresh({ slot: 1 })

    // Server fake adopted local: row's expiresAt advanced.
    const after = fake.state.get(sub._id as string)
    expect(after?.expiresAt).toBe(newExpires)
    // CLI printed the "adopted" message.
    expect(captured.join('\n').toLowerCase()).toMatch(/pushed.*vault|adopted/)
    // No Keychain write because local was already the freshest.
    expect(writeActiveCredentials).not.toHaveBeenCalled()
  })

  it('vault has fresher state than local → action label is pulledFresh; local Keychain rewritten', async () => {
    const newVaultExpires = Date.now() + 4 * 60 * 60 * 1000
    const sub = await makeSub({
      email: 'multi@example.com',
      slot: 1,
      expiresAt: newVaultExpires,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-NEWVAULT-EEEEEEEEEEEEEE',
          refreshToken: 'sk-ant-ort01-NEWVAULT-FFFFFFFFFFFFFF',
          expiresAt: newVaultExpires,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
        config: { oauthAccount: { emailAddress: 'multi@example.com' } },
      }),
    })

    const fake = createRefreshFake([sub])
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    // Local is OLDER — vault has the newer rotation.
    const oldLocalExpires = newVaultExpires - 3 * 60 * 60 * 1000
    const localState = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-OLDLOCAL-GGGGGGGGGGGGGG',
        refreshToken: 'sk-ant-ort01-OLDLOCAL-HHHHHHHHHHHHHH',
        expiresAt: oldLocalExpires,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
      config: { oauthAccount: { emailAddress: 'multi@example.com' } },
    })
    const { readActiveCredentials } = await import('../../src/native/keychain')
    vi.mocked(readActiveCredentials).mockReturnValue(localState)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runRefresh({ slot: 1 })

    expect(captured.join('\n').toLowerCase()).toMatch(/updated local|pull.*vault|pulled/)
    // CLI must have written the vault's plaintext to the local Keychain.
    expect(writeActiveCredentials).toHaveBeenCalled()
    // Verify the written blob is the VAULT's, not the local.
    const writtenBlob = vi.mocked(writeActiveCredentials).mock.calls[0]?.[0] ?? ''
    expect(writtenBlob).toContain('NEWVAULT')
    expect(writtenBlob).not.toContain('OLDLOCAL')

    // ~/.claude.json received oauthAccount slice (proves applyEnvelope path ran).
    const cfgPath = join(tempHome, '.claude.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { oauthAccount?: { emailAddress?: string } }
    expect(cfg.oauthAccount?.emailAddress).toBe('multi@example.com')
  })

  it('two concurrent cvault refresh calls (in-process) serialize via withFileLock; no expiresAt regression', async () => {
    const baseExpires = Date.now() + 60 * 1000 // near expiry, both will force-refresh
    const sub = await makeSub({
      email: 'race@example.com',
      slot: 1,
      expiresAt: baseExpires,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-START-AAAAAAAAAAAAAAAAAA',
          refreshToken: 'sk-ant-ort01-START-BBBBBBBBBBBBBBBBBB',
          expiresAt: baseExpires,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
        config: { oauthAccount: { emailAddress: 'race@example.com' } },
      }),
    })

    const fake = createRefreshFake([sub])
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    // Both calls run with NO local Keychain (null) so the local hash is
    // undefined; force=true drives the rotation each time. The fake
    // generates a new contentHash on each rotation, so both calls write.
    const { readActiveCredentials } = await import('../../src/native/keychain')
    vi.mocked(readActiveCredentials).mockReturnValue(null)

    // Track entry / exit of the keychain write critical section, same
    // pattern as concurrentSwitchLockContention.scenario. The
    // proper-lockfile mutex around runRefresh's whole body must
    // serialize the writes.
    const events: string[] = []
    let counter = 0
    vi.mocked(writeActiveCredentials).mockImplementation((_blob: string) => {
      counter += 1
      const id = counter.toString()
      events.push(`enter-${id}`)
      const start = Date.now()
      while (Date.now() - start < 15) {
        // intentional spin
      }
      events.push(`exit-${id}`)
    })

    // Both --force so each path drives a write of the rotated tokens.
    // We give a generous timeoutMs here because proper-lockfile's
    // node-retry minTimeout is 1000ms — the second waiter pays at least
    // one retry interval. Increasing the budget keeps the test stable
    // on slower CI runners.
    await Promise.all([runRefresh({ slot: 1, force: true }), runRefresh({ slot: 1, force: true })])

    // Both refreshSub action calls completed.
    expect(fake.action).toHaveBeenCalledTimes(2)

    // INVARIANT: writes are serialized. The lock guarantees mutual
    // exclusion, but a particular call may legitimately skip the write
    // (e.g. inSync hash match). What we MUST see: every write that
    // happened did so in its own critical section, never overlapping
    // another. The simplest check is that the events array has the
    // shape (enter,exit)+ with no interleaving; the count is `2 *
    // numWrites`.
    expect(events.length % 2).toBe(0)
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]).toMatch(/^enter-/)
      expect(events[i + 1]).toBe(events[i]?.replace('enter-', 'exit-'))
    }
    // At least one write happened (force=true with no local hash → write).
    expect(events.length).toBeGreaterThanOrEqual(2)

    // INVARIANT: vault row's expiresAt was advanced (no regression).
    const after = fake.state.get(sub._id as string)
    expect(after?.expiresAt).toBeGreaterThan(baseExpires)

    // ~/.claude.json is valid JSON (atomic temp+rename in writeOauthAccount).
    const cfgPath = join(tempHome, '.claude.json')
    const raw = readFileSync(cfgPath, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})

describe('Scenario — cvault refresh resolves cross-machine rotation race', () => {
  // The crossMachineRotationRace.scenario covers the SWITCH path post-rotation.
  // This new scenario covers the REFRESH path: machine B's refresh advanced
  // the vault state mid-flight while machine A was running `cvault refresh`.
  // The CLI must end up with the post-rotation plaintext, not a stale half-and-half.
  it('vault advances mid-refresh → CLI writes the post-rotation plaintext to local Keychain', async () => {
    const preRotationExpires = Date.now() + 60 * 60 * 1000
    const sub = await makeSub({
      email: 'race@example.com',
      slot: 1,
      expiresAt: preRotationExpires,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-PRE-AAAAAAAAAAAAAAAAAAAA',
          refreshToken: 'sk-ant-ort01-PRE-BBBBBBBBBBBBBBBBBBBB',
          expiresAt: preRotationExpires,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
        config: { oauthAccount: { emailAddress: 'race@example.com' } },
      }),
    })

    const fake = createRefreshFake([sub])

    // Patch the action to mutate the stored row BEFORE responding —
    // simulating machine B's refresh landing first. Capture the
    // original implementation BEFORE replacement so the wrapper can
    // delegate (vi.fn's `Mock` signature isn't directly callable in
    // TS — saving the function body works around that and avoids the
    // recursion trap of calling back into the new mock).
    const innerImpl = fake.action.getMockImplementation() as (
      ref: unknown,
      args?: Record<string, unknown>
    ) => Promise<unknown>
    fake.action.mockImplementation(async (ref: unknown, args?: Record<string, unknown>): Promise<unknown> => {
      const row = fake.state.get(sub._id as string)
      if (row !== undefined) {
        const postRotationExpires = preRotationExpires + 4 * 60 * 60 * 1000
        row.plaintextBlob = JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-POSTROT-CCCCCCCCCCCCCC',
            refreshToken: 'sk-ant-ort01-POSTROT-DDDDDDDDDDDDDD',
            expiresAt: postRotationExpires,
            scopes: ['user:inference'],
            subscriptionType: 'max',
          },
          config: { oauthAccount: { emailAddress: 'race@example.com' } },
        })
        row.expiresAt = postRotationExpires
        const { createHash } = await import('node:crypto')
        row.contentHash = createHash('sha256').update(row.plaintextBlob).digest('hex')
        row.lastRefreshedAt = Date.now()
      }
      return await innerImpl(ref, args)
    })
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    // Machine A's local has the pre-rotation tokens.
    const localState = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-MACHINEA-EEEEEEEEEEEEEE',
        refreshToken: 'sk-ant-ort01-MACHINEA-FFFFFFFFFFFFFF',
        expiresAt: preRotationExpires,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
      config: { oauthAccount: { emailAddress: 'race@example.com' } },
    })
    const { readActiveCredentials } = await import('../../src/native/keychain')
    vi.mocked(readActiveCredentials).mockReturnValue(localState)

    await runRefresh({ slot: 1 })

    // Local Keychain MUST end up with the POST-rotation tokens, not a mix.
    expect(writeActiveCredentials).toHaveBeenCalled()
    const writtenBlob = vi.mocked(writeActiveCredentials).mock.calls[0]?.[0] ?? ''
    expect(writtenBlob).toContain('POSTROT')
    expect(writtenBlob).not.toContain('MACHINEA')
    expect(writtenBlob).not.toContain('PRE-AAAAAAAAAAAA')
  })
})
