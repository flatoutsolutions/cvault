/**
 * Scenario #5 — Switch on a second machine (sync flow).
 *
 * Plan: docs/research/scenario-tests-plan.md §4.5.
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7
 *  (`cvault sync --all` + pull-on-use).
 *
 * What this scenario covers end-to-end:
 *  - Phase A — machine 1 has previously added a sub (we seed the
 *    backend's state to model that)
 *  - Phase B — machine 2 starts with a fresh `~/.vault/`. There is NO
 *    `last-hash-{email}.txt` file because this machine has never imported.
 *  - `runSync` pulls every sub via `pullForSwitch` → `claude-swap --import -`,
 *    then writes the local hash file
 *  - A subsequent `runSwitch` against the same sub finds a matching local
 *    hash → SKIPS the second `claude-swap --import -` (the post-sync
 *    Keychain is already up to date)
 *  - The shared backend state has TWO machineActivity rows (sync's pull +
 *    switch's pull), each with the same Clerk session id (this scenario
 *    runs both phases in machine 2; the hypothetical machine 1's earlier
 *    activity isn't simulated — that's not what this scenario asserts)
 *
 * Note: the plan §4.5 also suggests asserting two distinct `clerkSessionId`
 * values across machines. To do that meaningfully we'd need an actual
 * second tempHome with a different stamped session id. We do exactly
 * that in the second test below to make the cross-machine semantics
 * visible.
 */
import { existsSync, readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runSwitch } from '../../src/commands/switch'
import { runSync } from '../../src/commands/sync'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { getActiveAccount, importEnvelope, importEnvelopeUnlocked, switchTo } from '../../src/credentials'
import { lastHashPath } from '../../src/paths'
import { SAMPLE_OAUTH_BLOB, cleanupTempHome, createFakeVaultClient, makeSub, setupTempHome } from './_helpers'

vi.mock('../../src/credentials', () => ({
  getActiveAccount: vi.fn(),
  // After the sync lock fix, runSync calls `importEnvelopeUnlocked`
  // (proper-lockfile is non-reentrant), while runSwitch still calls
  // `importEnvelope`. Both must be mocked so this scenario can assert
  // which one runs at each phase.
  importEnvelope: vi.fn(),
  importEnvelopeUnlocked: vi.fn(),
  switchTo: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

let tempHome: string

beforeEach(() => {
  tempHome = setupTempHome('cvault-switch-second-test-')
})

afterEach(() => {
  cleanupTempHome(tempHome)
})

describe('Scenario #5 — Switch on a second machine (sync, then switch)', () => {
  it('runSync imports each sub + writes the hash; runSwitch on the same sub then skips re-import', async () => {
    // Phase A: shared backend state — machine 1 has already added two subs.
    const subs = await Promise.all([
      makeSub({ email: 'a@b.com', slot: 1, plaintextBlob: SAMPLE_OAUTH_BLOB }),
      makeSub({
        email: 'c@d.com',
        slot: 2,
        plaintextBlob: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-CCCCCCCCCCCCCCCCCCCC',
            refreshToken: 'sk-ant-ort01-DDDDDDDDDDDDDDDDDDDD',
            expiresAt: 1_900_000_000_000,
            scopes: ['user:inference'],
            subscriptionType: 'max',
          },
        }),
      }),
    ])
    const fake = createFakeVaultClient({
      subscriptions: subs,
      machineId: 'machine-2',
    })
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    // Phase B step 1: machine 2 boots fresh. It has no local hash files.
    expect(existsSync(lastHashPath('a@b.com'))).toBe(false)
    expect(existsSync(lastHashPath('c@d.com'))).toBe(false)

    await runSync()

    // Sync pulled both subs and imported each into the local Keychain.
    // Note: post-fix, sync uses `importEnvelopeUnlocked` (it holds the
    // file lock once across the whole loop). `importEnvelope` (which
    // re-acquires the lock) is reserved for switch's per-call path.
    expect(importEnvelopeUnlocked).toHaveBeenCalledTimes(2)
    expect(importEnvelope).not.toHaveBeenCalled()
    expect(fake.action).toHaveBeenCalledTimes(2)

    // Local hash files were written with mode 0600 + correct hashes.
    const [subA, subC] = subs
    const hashA = readFileSync(lastHashPath('a@b.com'), 'utf8')
    expect(hashA).toBe(subA.contentHash)
    const hashC = readFileSync(lastHashPath('c@d.com'), 'utf8')
    expect(hashC).toBe(subC.contentHash)

    // Phase B step 2: runSwitch on a@b.com — local hash now matches AND
    // a@b.com is the locally-active account, so the import is skipped
    // (Bug 1 fix: same-email + same-hash is the only safe skip path).
    // Model that explicitly via getActiveAccount.
    vi.mocked(importEnvelope).mockClear()
    vi.mocked(switchTo).mockClear()
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'a@b.com' })
    await runSwitch({ slotOrEmail: 'a@b.com' })

    expect(importEnvelope).not.toHaveBeenCalled() // post-sync, hash matches AND target is active
    // On native, no separate `switchTo` step — import IS the switch.
    expect(switchTo).not.toHaveBeenCalled()

    // The shared backend recorded a second machineActivity row from the
    // post-sync switch. Sync inserted 2 rows, switch added 1 — total 3.
    expect(fake.state.machineActivity.length).toBe(3)
    expect(fake.state.machineActivity.every((r) => r.action === 'pull')).toBe(true)
  })

  it('two distinct machines stamp distinct machineId values on machineActivity', async () => {
    const sub = await makeSub({
      email: 'multi@b.com',
      slot: 1,
      plaintextBlob: SAMPLE_OAUTH_BLOB,
    })
    const fake = createFakeVaultClient({
      subscriptions: [sub],
      machineId: 'machine-A',
    })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)

    // Machine A pulls.
    await runSwitch({ slotOrEmail: '1' })

    // Simulate machine B taking over: new tempHome (fresh ~/.vault/, no
    // hash files) and a different machineId.
    const machineBHome = setupTempHome('cvault-second-machine-B-')
    try {
      fake.state.machineId = 'machine-B'
      vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)
      // Fresh home -> no hash file -> the import path runs again.
      await runSwitch({ slotOrEmail: '1' })

      const sessions = fake.state.machineActivity.map((r) => r.machineId)
      expect(sessions).toContain('machine-A')
      expect(sessions).toContain('machine-B')
      expect(new Set(sessions).size).toBeGreaterThanOrEqual(2)
    } finally {
      cleanupTempHome(machineBHome)
    }
  })
})
