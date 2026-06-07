/**
 * Scenario #13 — Mixed-case email roundtrip across `cvault add` and `cvault remove`.
 *
 * Plan: Track B item 12c (production-deployment spec).
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7
 *  + cli/src/commands/list.ts:33-37 ("R2: case-insensitive compare —
 *    Anthropic emails are case-insensitive at SMTP and Clerk normalizes
 *    inconsistently").
 *
 * What this scenario covers end-to-end:
 *  - The user runs `cvault add` while Anthropic returns a mixed-case
 *    email (`Stefan@Example.com`). Production canonicalizes the email
 *    to lowercase at write time so the vault stores `stefan@example.com`.
 *  - The user later runs `cvault remove stefan@example.com` (lowercase).
 *    The server-side lookup finds the row trivially.
 *  - Symmetric case: stored canonical → removed via uppercase
 *    (`STEFAN@EXAMPLE.COM`). The server-side `softRemove` lowercases
 *    the lookup key, matching the canonicalized stored email.
 *
 * Why this is a scenario (not a unit test):
 *  - The bug only surfaces when add and remove run with case-divergent
 *    emails. Either command alone passes a unit test; the round-trip
 *    is the regression surface.
 *  - The convex unit tests
 *    (`convex/subscriptions/mutations.test.ts`) already prove the
 *    server-side canonicalization. This scenario proves the CLI
 *    pipeline preserves it end-to-end.
 *
 * Stubbed:
 *  - `addAccountInteractive`/`exportAccount`/`getActiveAccount` — the
 *    interactive `claude` spawn isn't part of the case-handling
 *    contract.
 *  - `makeVaultClient` — wired to in-memory FakeVaultClient. The fake's
 *    `softRemove` and `upsertFromPlaintext` mirror production
 *    canonicalization (see `cli/tests/scenarios/_helpers.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runAdd } from '../../src/commands/add'
import { runRemove } from '../../src/commands/remove'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { exportAccount, getActiveAccount } from '../../src/credentials'
import { singleAccountEnvelope } from '../fixtures/envelopes/singleAccount'
import { cleanupTempHome, createFakeVaultClient, setupTempHome } from './_helpers'

vi.mock('../../src/credentials', () => ({
  addAccountInteractive: vi.fn().mockResolvedValue(undefined),
  exportAccount: vi.fn(),
  getActiveAccount: vi.fn(),
  importEnvelope: vi.fn().mockResolvedValue(undefined),
  removeAccount: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

let tempHome: string

beforeEach(() => {
  tempHome = setupTempHome('cvault-mixed-case-email-')
})

afterEach(() => {
  cleanupTempHome(tempHome)
})

describe('Scenario #13 — Mixed-case email roundtrip', () => {
  it('add Stefan@Example.com then remove stefan@example.com (lowercase) clears the row', async () => {
    // Phase 1: cvault add captures an active credential whose email is
    // mixed-case (this is what Anthropic actually returns when the user
    // signs in via OAuth — case is preserved from the SMTP record).
    // runAdd snapshots the currently-active account on the machine.
    // M7 hardening throws when there's no active account, so the test
    // mock returns one before the export step picks up the envelope.
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'Stefan@Example.com' })
    const env = singleAccountEnvelope({ number: 1, email: 'Stefan@Example.com' })
    env.accounts[0]!.credentials.claudeAiOauth.expiresAt = 1_900_000_000_000
    vi.mocked(exportAccount).mockReturnValueOnce(env)

    const fake = createFakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    await runAdd({})

    // Production canonicalizes email to lowercase at write time, so the
    // stored row's email is the canonical form regardless of how
    // Anthropic capitalized it on the wire.
    const stored = Array.from(fake.state.subscriptions.values()).find((s) => s.removedAt === undefined)
    expect(stored?.email).toBe('stefan@example.com')

    // Phase 2: remove using the lowercase form. The server-side
    // `softRemove` finds the canonical row trivially.
    //
    // The `runRemove` flow consults `getActiveAccount` to decide whether
    // to also clear the local credentials. We don't want to assert on
    // that branch here (covered by `forceRemoveCli.scenario.test.ts`);
    // returning null keeps the active-clear path inert.
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)
    await runRemove({ slotOrEmail: 'stefan@example.com' })

    // Server-side: the row is now soft-removed.
    const afterRemove = Array.from(fake.state.subscriptions.values()).find((s) => s.email === 'stefan@example.com')
    expect(afterRemove?.removedAt).toBeTypeOf('number')
  })

  it('add Stefan@Example.com then remove STEFAN@EXAMPLE.COM (uppercase) clears the row', async () => {
    // runAdd snapshots the currently-active account on the machine.
    // M7 hardening throws when there's no active account, so the test
    // mock returns one before the export step picks up the envelope.
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'Stefan@Example.com' })
    const env = singleAccountEnvelope({ number: 1, email: 'Stefan@Example.com' })
    env.accounts[0]!.credentials.claudeAiOauth.expiresAt = 1_900_000_000_000
    vi.mocked(exportAccount).mockReturnValueOnce(env)

    const fake = createFakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    await runAdd({})

    const stored = Array.from(fake.state.subscriptions.values()).find((s) => s.removedAt === undefined)
    expect(stored?.email).toBe('stefan@example.com')

    // See comment in the lowercase test: keep the local-clear branch inert.
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)
    await runRemove({ slotOrEmail: 'STEFAN@EXAMPLE.COM' })

    const afterRemove = Array.from(fake.state.subscriptions.values()).find((s) => s.email === 'stefan@example.com')
    expect(afterRemove?.removedAt).toBeTypeOf('number')
  })
})
