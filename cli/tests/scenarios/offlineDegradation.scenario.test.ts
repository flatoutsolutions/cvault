/**
 * Scenario #12 — Offline behavior on the CLI.
 *
 * Plan: docs/research/scenario-tests-plan.md §4.12.
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7
 *  ("Offline degradation").
 *
 * Behavior change (M6, 2026-05-02):
 *  Native has no per-slot local backup pool — `switchTo` is a no-op. The
 *  legacy "fall back to a local switch" path was meaningless because
 *  there's no second account to switch *to*. We now fail loud: throw a
 *  clear error explaining that credentials cannot be rotated without
 *  Convex, and exit non-zero. The previously-active sub (whatever was
 *  last imported) remains usable locally; the user just can't rotate to
 *  a different one until Convex is reachable.
 *
 * Two flavors of network failure are exercised:
 *  - `makeVaultClient` itself throws (DNS failure resolving the
 *    deployment URL).
 *  - The client constructs but the action call throws a network error
 *    (connection refused mid-call).
 *
 * A separate test asserts the contrasting case: a NON-network error
 * (e.g. `500 InternalError: VAULT_AES_KEY missing`) re-throws unchanged
 * so real server bugs aren't masked by the offline-handling code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runSwitch } from '../../src/commands/switch'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { importEnvelope, switchTo } from '../../src/credentials'
import { cleanupTempHome, setupTempHome } from './_helpers'

vi.mock('../../src/credentials', () => ({
  importEnvelope: vi.fn(),
  switchTo: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

let tempHome: string

beforeEach(() => {
  tempHome = setupTempHome('cvault-offline-test-')
})

afterEach(() => {
  cleanupTempHome(tempHome)
})

describe('Scenario #12 — Offline (fail loud)', () => {
  it('throws a clear OfflineError when makeVaultClient itself throws a DNS / fetch failure', async () => {
    vi.mocked(makeVaultClient).mockRejectedValueOnce(
      new Error('fetch failed: getaddrinfo ENOTFOUND beloved-mouse-707.convex.cloud')
    )

    await expect(runSwitch({ slotOrEmail: '2' })).rejects.toThrow(/Convex.*unreachable|cannot rotate/i)

    // No silent fallback — neither import nor switch fired.
    expect(switchTo).not.toHaveBeenCalled()
    expect(importEnvelope).not.toHaveBeenCalled()
  })

  it('throws when the action call rejects mid-flight with a network-shaped error', async () => {
    const fakeClient = {
      query: vi.fn(),
      action: vi.fn().mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED 127.0.0.1:443')),
      mutation: vi.fn(),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fakeClient as never)

    await expect(runSwitch({ slotOrEmail: '3' })).rejects.toThrow(/Convex.*unreachable|cannot rotate/i)

    expect(fakeClient.action).toHaveBeenCalledOnce()
    expect(switchTo).not.toHaveBeenCalled()
    expect(importEnvelope).not.toHaveBeenCalled()
  })

  it('does NOT swallow non-network errors (re-throws instead)', async () => {
    const fakeClient = {
      query: vi.fn(),
      action: vi.fn().mockRejectedValueOnce(new Error('500 InternalError: VAULT_AES_KEY missing')),
      mutation: vi.fn(),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fakeClient as never)

    await expect(runSwitch({ slotOrEmail: '4' })).rejects.toThrow(/VAULT_AES_KEY/)

    // Critical: silently swallowing this would hide a real server bug.
    expect(switchTo).not.toHaveBeenCalled()
    expect(importEnvelope).not.toHaveBeenCalled()
  })
})
