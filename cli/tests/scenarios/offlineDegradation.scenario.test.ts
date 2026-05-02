/**
 * Scenario #12 — Offline degradation on the CLI.
 *
 * Plan: docs/research/scenario-tests-plan.md §4.12.
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7
 *  ("Offline degradation").
 *
 * What this scenario covers end-to-end:
 *  - Convex is unreachable. `runSwitch` MUST fall back to local
 *    `claude-swap --switch-to <slot>` directly so the user can still
 *    switch between accounts they already have in their Keychain.
 *  - The CLI prints a warning matching /offline|local cache/i so the
 *    user knows to expect the active sub may be stale.
 *  - It MUST NOT call `claude-swap --import -` in the offline path —
 *    we don't have fresh credentials to import.
 *
 * Two flavors of network failure are exercised, both of which the CLI's
 * `isNetworkError` heuristic should treat as "fall back":
 *  - `makeVaultClient` itself throws (e.g. DNS failure resolving the
 *    deployment URL) — the CLI never even gets a client back
 *  - The client constructs but the action call throws a network error
 *    (e.g. connection refused mid-call)
 *
 * A separate test asserts the contrasting case: a NON-network error
 * (e.g. `500 InternalError: VAULT_AES_KEY missing`) MUST re-throw,
 * not silently fall back. Eating non-network errors would mask real
 * server bugs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { importEnvelope, switchTo } from '../../src/claudeSwap'
import { runSwitch } from '../../src/commands/switch'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { cleanupTempHome, setupTempHome } from './_helpers'

vi.mock('../../src/claudeSwap', () => ({
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

describe('Scenario #12 — Offline degradation', () => {
  it('falls back to local switchTo when makeVaultClient itself throws a DNS / fetch failure', async () => {
    vi.mocked(makeVaultClient).mockRejectedValueOnce(
      new Error('fetch failed: getaddrinfo ENOTFOUND beloved-mouse-707.convex.cloud')
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await runSwitch({ slotOrEmail: '2' })

    // Fell back to local switch.
    expect(switchTo).toHaveBeenCalledWith('2')
    // Did NOT attempt an import — we have no fresh blob to import.
    expect(importEnvelope).not.toHaveBeenCalled()
    // Printed a warning the user can recognize.
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/offline|local cache/i))
    warnSpy.mockRestore()
  })

  it('falls back when the action call rejects mid-flight with a network-shaped error', async () => {
    const fakeClient = {
      query: vi.fn(),
      action: vi.fn().mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED 127.0.0.1:443')),
      mutation: vi.fn(),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fakeClient as never)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await runSwitch({ slotOrEmail: '3' })

    expect(fakeClient.action).toHaveBeenCalledOnce()
    expect(switchTo).toHaveBeenCalledWith('3')
    expect(importEnvelope).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it('does NOT fall back when the action throws a non-network error (re-throws instead)', async () => {
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
