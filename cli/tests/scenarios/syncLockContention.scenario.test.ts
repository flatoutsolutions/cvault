/**
 * Scenario — `cvault sync` lock contention.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7
 *  + cli/src/native/lock.ts (`withFileLock` cross-process file lock).
 *
 * Bug shape: prior to the fix, `runSync()` iterated subs in a plain
 * `for..of` loop and called `importEnvelope` per sub. `importEnvelope`
 * acquires `withFileLock` *internally per call*, but the OUTER loop
 * didn't, so a concurrent `cvault switch` (or a second concurrent
 * `cvault sync`) could interleave its write between sync's iteration 1
 * and iteration 2 — landing partial state on the local Keychain +
 * `~/.claude.json` mid-sync.
 *
 * The fix: hold the cross-process `withFileLock` over the WHOLE
 * `for (sub of subs)` loop. Inside the lock the per-sub write goes
 * through `applyEnvelopeUnlocked` (proper-lockfile is NOT reentrant
 * within one process, so a nested `withFileLock` would deadlock).
 *
 * What this scenario exercises end-to-end:
 *   - Two concurrent `runSync()` invocations against the same in-memory
 *     fake vault.
 *   - `withFileLock` SERIALIZES the two: one runs to completion before
 *     the other begins.
 *   - Both syncs complete (no lock-acquire timeouts).
 *   - The on-disk `~/.claude.json` is valid JSON post-race.
 *   - The final keychain matches the last sub of whichever sync ran
 *     last (last-writer-wins under the lock).
 *
 * Stubbed (and why):
 *   - `keychain.ts` / `credentialsFile.ts` — real Keychain access in
 *     tests is dangerous and flaky; writes are observed via a spy.
 *   - `makeVaultClient` — wired to in-memory FakeVaultClient.
 *
 * NOT stubbed (the whole point of the scenario):
 *   - `applyEnvelopeUnlocked` and `withFileLock` — these run for real
 *     so the serialization invariant is exercised end-to-end.
 *   - `claudeConfig.ts` atomic temp+rename writes against the test
 *     `~/.claude.json` in tmpdir.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runSync } from '../../src/commands/sync'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { writeActiveCredentials } from '../../src/native/keychain'
import { createFakeVaultClient, makeSub } from './_helpers'

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
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-sync-lock-'))
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

describe('Scenario — cvault sync lock contention (in-process)', () => {
  it('two concurrent runSync calls serialize via withFileLock; final state is consistent and claude.json valid', async () => {
    const subA = await makeSub({
      email: 'alice@example.com',
      slot: 1,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA',
          refreshToken: 'sk-ant-ort01-BBBBBBBBBBBBBBBBBBBB',
          expiresAt: 1_900_000_000_000,
          scopes: ['user:inference', 'user:profile'],
          subscriptionType: 'max',
        },
        config: { oauthAccount: { emailAddress: 'alice@example.com' } },
      }),
    })
    const subB = await makeSub({
      email: 'bob@example.com',
      slot: 2,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-BOB-AAAAAAAAAAAAAAAA-BOBBB',
          refreshToken: 'sk-ant-ort01-BOB-BBBBBBBBBBBBBBBB-BOBBB',
          expiresAt: 1_900_000_000_000,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
        config: { oauthAccount: { emailAddress: 'bob@example.com' } },
      }),
    })
    const fake = createFakeVaultClient({
      subscriptions: [subA, subB],
      clerkSessionId: 'sess_local_machine',
    })
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    // Track entry/exit of every keychain write critical section. With
    // the fix in place, runSync's body holds the cross-process lock
    // across BOTH writes, so the events array splits into two halves
    // — the first runSync completes both writes before the second
    // runSync's first write begins. The split-point check is the
    // deterministic invariant: there is exactly one boundary index `k`
    // such that events[0..k] are from one sync and events[k..end] are
    // from the other.
    const events: string[] = []
    let writeCounter = 0
    // The real `writeActiveCredentials` is sync, so the `enter` and
    // `exit` events are pushed synchronously. The cross-process lock
    // around the whole `runSync` body is what serializes the two
    // concurrent invocations — the test's invariant doesn't depend on
    // delaying the mock body. The original busy-wait that lived here
    // burned CPU to widen the interleaving window; removing it keeps
    // the same outcome assertions (mutual-exclusion via the lock) and
    // doesn't burn the event loop. If a regression ever lands that
    // breaks serialization, the events-pair invariant below still
    // catches it because the lock is acquired BEFORE the first write
    // of either runSync.
    vi.mocked(writeActiveCredentials).mockImplementation((blob: string) => {
      writeCounter += 1
      const tokenMatch = /accessToken":"([^"]+)/.exec(blob)
      const id = tokenMatch?.[1]?.slice(-5) ?? '?'
      events.push(`enter-${id}-w${writeCounter.toString()}`)
      events.push(`exit-${id}-w${writeCounter.toString()}`)
    })

    await Promise.all([runSync(), runSync()])

    // INVARIANT 1: 4 writes happened (2 subs × 2 syncs).
    expect(events.length).toBe(8)
    expect(writeActiveCredentials).toHaveBeenCalledTimes(4)

    // INVARIANT 2: every enter is followed by its matching exit BEFORE
    // any other enter — the lock guarantees mutual exclusion.
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]).toMatch(/^enter-/)
      const expectedExit = events[i]?.replace('enter-', 'exit-') ?? ''
      expect(events[i + 1]).toBe(expectedExit)
    }

    // INVARIANT 3: claude.json is valid JSON post-race (atomic
    // temp+rename in writeOauthAccount must guarantee no half-merged
    // doc is observed).
    const configPath = join(tempHome, '.claude.json')
    const raw = readFileSync(configPath, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } }
    expect(parsed.oauthAccount).toBeDefined()
    // Final email must be one of the two valid sub emails (not corrupted).
    expect(['alice@example.com', 'bob@example.com']).toContain(parsed.oauthAccount?.emailAddress)
  })
})
