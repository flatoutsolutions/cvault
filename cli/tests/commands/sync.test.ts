/**
 * Spec: §7 — `cvault sync --all`.
 *
 * Bootstrap on a fresh machine: pull every sub from Convex, import each
 * into the local Keychain. Equivalent to running `cvault switch` for
 * every sub but in one round-trip.
 *
 * The dispatch is per-sub: for each sub returned by `listForUser`, we
 * call the same `pullForSwitch` action used by `cvault switch`, then
 * `claude-swap --import -` for each. We do NOT call `claude-swap
 * --switch-to` at the end — the user picks the active sub afterward.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runSync } from '../../src/commands/sync'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { importEnvelope, importEnvelopeUnlocked } from '../../src/credentials'
import { withFileLock } from '../../src/native/lock'
import { noopWithMachineLabel, noopWithMeta } from '../scenarios/_helpers'

vi.mock('../../src/credentials', () => ({
  importEnvelope: vi.fn(),
  importEnvelopeUnlocked: vi.fn(),
}))

vi.mock('../../src/native/lock', () => ({
  // Identity wrapper — the lock is exercised in lock.test.ts. Here we
  // just want to verify `withFileLock` is the wrapping primitive AND
  // that the body runs under it.
  withFileLock: vi.fn(<T>(fn: () => Promise<T> | T) => Promise.resolve(fn())),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

const SAMPLE_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-abc',
    refreshToken: 'sk-ant-ort01-def',
    expiresAt: 1_900_000_000_000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
})

let tempHome: string

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-sync-test-'))
  vi.stubEnv('HOME', tempHome)
})

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true })
})

describe('runSync', () => {
  it('imports every sub returned by listForUser', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([
        { slot: 1, email: 'a@b.com' },
        { slot: 2, email: 'c@d.com' },
      ]),
      action: vi.fn(),
    }
    client.action
      .mockResolvedValueOnce({
        email: 'a@b.com',
        slot: 1,
        plaintextBlob: SAMPLE_BLOB,
        contentHash: 'h1',
      })
      .mockResolvedValueOnce({
        email: 'c@d.com',
        slot: 2,
        plaintextBlob: SAMPLE_BLOB,
        contentHash: 'h2',
      })
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    await runSync()

    expect(client.query).toHaveBeenCalledOnce()
    expect(client.action).toHaveBeenCalledTimes(2)
    // After the lock fix, sync acquires the lock once per call and
    // dispatches per-sub writes through `importEnvelopeUnlocked`.
    // Calling `importEnvelope` (which would re-acquire the lock) would
    // deadlock on the second sub, since proper-lockfile is NOT
    // reentrant within one process.
    expect(importEnvelopeUnlocked).toHaveBeenCalledTimes(2)
    expect(importEnvelope).not.toHaveBeenCalled()
  })

  // After the lock fix, runSync must acquire the cross-process file
  // lock ONCE for the whole loop — never per iteration. Holding the
  // lock across the whole batch is what prevents a concurrent
  // `cvault switch` from interleaving its write between sync's
  // iteration N and iteration N+1.
  it('acquires the cross-process file lock once for the whole sync loop', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([
        { slot: 1, email: 'a@b.com' },
        { slot: 2, email: 'c@d.com' },
      ]),
      action: vi.fn(),
    }
    client.action
      .mockResolvedValueOnce({ email: 'a@b.com', slot: 1, plaintextBlob: SAMPLE_BLOB, contentHash: 'h1' })
      .mockResolvedValueOnce({ email: 'c@d.com', slot: 2, plaintextBlob: SAMPLE_BLOB, contentHash: 'h2' })
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    await runSync()

    // Exactly one call to `withFileLock` across the whole sync —
    // not one per sub.
    expect(withFileLock).toHaveBeenCalledTimes(1)
  })

  it('continues importing remaining subs even if one fails', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([
        { slot: 1, email: 'a@b.com' },
        { slot: 2, email: 'c@d.com' },
      ]),
      action: vi.fn(),
    }
    client.action
      .mockResolvedValueOnce({
        email: 'a@b.com',
        slot: 1,
        plaintextBlob: SAMPLE_BLOB,
        contentHash: 'h1',
      })
      .mockRejectedValueOnce(new Error('refresh token expired'))
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await runSync()

    expect(importEnvelopeUnlocked).toHaveBeenCalledOnce()
    expect(importEnvelope).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/c@d\.com.*refresh/i))
    errSpy.mockRestore()
  })

  // The shared vault stores subs FCFS; every user's first sub has
  // `slot=1`, so rendering `slot=${sub.slot}` for each line in the
  // output of `cvault sync` prints duplicate "(slot 1)" rows when the
  // user has multiple subs from different `userId` partitions. The fix
  // is the same one applied to `cvault list` in commit 10b10a9: render
  // the 1-indexed position in the FCFS-ordered server response as
  // "rank N" instead of leaning on the stored slot.
  it('prints (rank N) — not (slot N) — when listForUser returns multiple subs that share slot=1', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([
        // Two subs that both stored slot=1 (this is the shared-vault
        // shape: every user's first is slot 1).
        { slot: 1, email: 'first@b.com' },
        { slot: 1, email: 'second@d.com' },
      ]),
      action: vi.fn(),
    }
    client.action
      .mockResolvedValueOnce({ email: 'first@b.com', slot: 1, plaintextBlob: SAMPLE_BLOB, contentHash: 'h1' })
      .mockResolvedValueOnce({ email: 'second@d.com', slot: 1, plaintextBlob: SAMPLE_BLOB, contentHash: 'h2' })
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runSync()

    const out = captured.join('\n')
    expect(out).toContain('(rank 1)')
    expect(out).toContain('(rank 2)')
    // The misleading "(slot 1)" repeated for every sub MUST NOT appear.
    expect(out).not.toMatch(/\(slot \d+\)/)
  })

  it('prints a friendly message when there are no subs', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([]),
      action: vi.fn(),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await runSync()
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/no subscriptions/i))
    expect(client.action).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })
})
