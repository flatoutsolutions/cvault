/**
 * Scenario — shared-vault email dedupe across users (audit fix #4).
 *
 * Background:
 *   The shared-vault model (`convex/utils/users.ts:3-7`) lets any
 *   authenticated allowed-domain caller resolve any subscription row
 *   regardless of nominal owner. Read paths (`getMetaByEmail`,
 *   `listAllActiveSubsRaw`, …) and the public `softRemove` / `rename`
 *   mutations index by `byEmail` (global). The `upsertSub` write path,
 *   however, was deduping by `byUserAndEmail` (per-user). Result: when
 *   two distinct Clerk users add the same Anthropic email, the row
 *   tally is TWO rather than ONE — the dashboard renders both, backup
 *   exports both, and `cvault list` shows duplicates.
 *
 * Audit fix:
 *   Change `upsertSub`'s dedupe lookup to the global `byEmail` index.
 *   When an existing row has a DIFFERENT `userId` than the caller, KEEP
 *   the original `userId` (first-claimer keeps ownership; subsequent
 *   adders rotate ciphertext + label only). This matches the "shared
 *   vault" doctrine: tokens are shared, ownership is just a bookkeeping
 *   field.
 *
 * What this scenario asserts:
 *   1. User A calls `upsertFromPlaintext` for `samuel@x.com` — one row
 *      lands, owned by A.
 *   2. User B calls `upsertFromPlaintext` for the same email with a
 *      DIFFERENT plaintext blob — still ONE row, ciphertext is B's
 *      (last writer wins), `userId` is still A (first claimer keeps it).
 *   3. The dashboard / backup readers see exactly one row for that email.
 *
 * If this scenario regresses, two rows with the same email coexist and
 * the bug Stefan filed in the audit returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../../_generated/api'
import { __setAnthropicFetch } from '../../subscriptions/anthropic'
import { decrypt } from '../../subscriptions/crypto'
import { SECOND_IDENTITY, TEST_IDENTITY, vault } from '../helpers'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 47).toString('base64')
  // Stub Anthropic so the scheduled `fetchUsageForSub` triggered by
  // `upsertFromPlaintext` returns a quiet 429 (the action swallows
  // non-fatal failures and the scheduler queue closes cleanly).
  __setAnthropicFetch((() => Promise.resolve(new Response('rate-limited', { status: 429 }))) as typeof fetch)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  __setAnthropicFetch(undefined)
  if (ORIGINAL_KEY === undefined) {
    delete process.env.VAULT_AES_KEY
  } else {
    process.env.VAULT_AES_KEY = ORIGINAL_KEY
  }
})

function makeBlob(suffix: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat01-${suffix}-AT-AAAAAAAAAAAAAAAA`,
      refreshToken: `sk-ant-ort01-${suffix}-RT-BBBBBBBBBBBBBBBB`,
      expiresAt: 1700000000000,
      scopes: ['user:inference'],
    },
  })
}

describe('Scenario — shared-vault dedupe: two users adding the same email yield ONE row', () => {
  it('upsertFromPlaintext as user A then user B for the same email = exactly one row', async () => {
    const t = vault()

    // Seed both Clerk users in the `users` table so the action's identity
    // resolution succeeds (mirrors what the Clerk webhook would do
    // post-signup). Both addresses are allowed-domain.
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: TEST_IDENTITY.subject,
        name: TEST_IDENTITY.name,
        primaryEmail: TEST_IDENTITY.email,
        otherEmails: [],
      })
      await ctx.db.insert('users', {
        externalId: SECOND_IDENTITY.subject,
        name: SECOND_IDENTITY.name,
        primaryEmail: SECOND_IDENTITY.email,
        otherEmails: [],
      })
    })

    const sharedEmail = 'samuel@x.com'
    const expiresAt = Date.now() + 60 * 60 * 1000

    // ---------- User A claims the email ----------
    const aBlob = makeBlob('USER-A-FIRST')
    const aResult = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: sharedEmail,
      plaintextBlob: aBlob,
      expiresAt,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    // After user A: exactly one row in the table, owned by A.
    const afterA = await t.run(async (ctx) =>
      (await ctx.db.query('subscriptions').collect()).filter((r) => r.email === sharedEmail)
    )
    expect(afterA).toHaveLength(1)
    expect(afterA[0]?.userId).toEqual(aResult.userId)

    // ---------- User B writes the same email with different ciphertext ----------
    const bBlob = makeBlob('USER-B-SECOND')
    await t.withIdentity(SECOND_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: sharedEmail,
      plaintextBlob: bBlob,
      expiresAt: expiresAt + 1, // ensure recognizably different
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    // INVARIANT: still EXACTLY one row in the table for this email.
    // Pre-fix this would be 2: per-user dedupe missed the cross-user collision.
    const afterB = await t.run(async (ctx) =>
      (await ctx.db.query('subscriptions').collect()).filter((r) => r.email === sharedEmail)
    )
    expect(afterB).toHaveLength(1)

    // INVARIANT: ciphertext is B's (last writer wins). We decrypt with
    // the test key and look for the marker baked into the blob.
    const stored = afterB[0]
    expect(stored).toBeDefined()
    if (!stored) throw new Error('unreachable')
    const plaintext = decrypt(stored.ciphertext, stored.nonce, stored.keyVersion)
    expect(plaintext).toContain('USER-B-SECOND')
    expect(plaintext).not.toContain('USER-A-FIRST')

    // INVARIANT: ownership stays with the first claimer. This is the
    // shared-vault doctrine — tokens are shared but ownership tracks
    // the original adder.
    expect(stored.userId).toEqual(aResult.userId)
  })

  it('the dashboard `list` query returns exactly one row after the cross-user upsert (no duplicates)', async () => {
    // Companion check: the duplicate-row bug surfaced as TWO rows for
    // the same email in the dashboard's "Subscriptions" list. After the
    // fix, a single row should appear regardless of which user queries.
    const t = vault()
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: TEST_IDENTITY.subject,
        name: TEST_IDENTITY.name,
        primaryEmail: TEST_IDENTITY.email,
        otherEmails: [],
      })
      await ctx.db.insert('users', {
        externalId: SECOND_IDENTITY.subject,
        name: SECOND_IDENTITY.name,
        primaryEmail: SECOND_IDENTITY.email,
        otherEmails: [],
      })
    })

    const sharedEmail = 'shared@flatout.solutions'
    const expiresAt = Date.now() + 60 * 60 * 1000

    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: sharedEmail,
      plaintextBlob: makeBlob('A'),
      expiresAt,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    await t.withIdentity(SECOND_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: sharedEmail,
      plaintextBlob: makeBlob('B'),
      expiresAt: expiresAt + 1,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const fromA = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.list, {})
    expect(fromA.filter((r) => r.email === sharedEmail)).toHaveLength(1)
    const fromB = await t.withIdentity(SECOND_IDENTITY).query(api.subscriptions.queries.list, {})
    expect(fromB.filter((r) => r.email === sharedEmail)).toHaveLength(1)
  })
})
