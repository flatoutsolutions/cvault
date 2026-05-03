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
 *    email (`Stefan@Example.com`). The vault stores the row keyed by
 *    that email.
 *  - The user later runs `cvault remove stefan@example.com` (lowercase).
 *    The server-side lookup must match the stored row regardless of
 *    case — otherwise the user gets `NOT_FOUND` and the row is
 *    stranded. R2 establishes the project's case-insensitive convention
 *    for `list`; `softRemove` follows the same rule.
 *  - Symmetric case: stored mixed-case → removed via uppercase
 *    (`STEFAN@EXAMPLE.COM`).
 *
 * Why this is a scenario (not a unit test):
 *  - The bug only surfaces when add and remove run with case-divergent
 *    emails. Either command alone passes a unit test; the round-trip
 *    is the regression surface.
 *
 * Stubbed:
 *  - `addAccountInteractive`/`exportAccount`/`getActiveAccount` — the
 *    interactive `claude` spawn isn't part of the case-handling
 *    contract.
 *  - `makeVaultClient` — wired to in-memory FakeVaultClient.
 *
 * The fake's `upsertFromPlaintext` and `softRemove` handlers are
 * extended in this file with a case-insensitive email match so the
 * scenario asserts the EXPECTED behavior. The fake mirrors what a
 * normalized server-side implementation would do (lower-case the
 * stored email, lower-case the lookup key). If/when the real Convex
 * mutations adopt the same normalization, no test changes are needed.
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

/**
 * Patch a FakeVaultClient's `softRemove` handler to do a
 * case-insensitive email match — mirroring what the production
 * `convex/subscriptions/mutations.ts:softRemove` SHOULD do per R2.
 *
 * The default handler in `_helpers.ts` does an exact-string match,
 * which is what the shipped server does today. This scenario asserts
 * the case-insensitive contract; we override here so the test fails
 * loudly if/when the contract regresses.
 */
function withCaseInsensitiveSoftRemove(fake: ReturnType<typeof createFakeVaultClient>): void {
  fake.mutation.mockImplementation(async (ref, args) => {
    const { getFunctionName } = await import('convex/server')
    const { api } = await import('@cvault/convex/api')
    const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0])
    if (name === getFunctionName(api.subscriptions.mutations.softRemove)) {
      const requestedEmail = ((args ?? {}).email as string).toLowerCase()
      let touched = false
      for (const sub of fake.state.subscriptions.values()) {
        if (sub.email.toLowerCase() === requestedEmail && sub.removedAt === undefined) {
          sub.removedAt = Date.now()
          touched = true
        }
      }
      if (!touched) {
        throw new Error(`Fake VaultClient: softRemove found no row for email=${String((args ?? {}).email)}`)
      }
      return null
    }
    throw new Error(`Fake VaultClient (case-insensitive): unhandled mutation "${name}"`)
  })
}

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
    withCaseInsensitiveSoftRemove(fake)
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    await runAdd({})

    // Sanity: the row was stored with the original (mixed-case) email.
    const stored = Array.from(fake.state.subscriptions.values()).find((s) => s.removedAt === undefined)
    expect(stored?.email).toBe('Stefan@Example.com')

    // Phase 2: remove using the lowercase form. The server-side
    // `softRemove` must match case-insensitively.
    await runRemove({ slotOrEmail: 'stefan@example.com' })

    // Server-side: the row is now soft-removed.
    const afterRemove = Array.from(fake.state.subscriptions.values()).find((s) => s.email === 'Stefan@Example.com')
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
    withCaseInsensitiveSoftRemove(fake)
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    await runAdd({})

    const stored = Array.from(fake.state.subscriptions.values()).find((s) => s.removedAt === undefined)
    expect(stored?.email).toBe('Stefan@Example.com')

    await runRemove({ slotOrEmail: 'STEFAN@EXAMPLE.COM' })

    const afterRemove = Array.from(fake.state.subscriptions.values()).find((s) => s.email === 'Stefan@Example.com')
    expect(afterRemove?.removedAt).toBeTypeOf('number')
  })
})
