/**
 * Spec: §5 (refreshLog feed) + §8 (`/dashboard/audit` route).
 *
 * SHARED-VAULT CONTRACT (see `convex/utils/users.ts:3-7`): any authenticated,
 * allowlisted Clerk identity reads/writes the same vault. These tests
 * pin that contract for the refreshLog feed: rows are NOT scoped to the
 * caller's userId — every authed user sees the full audit history.
 */
import { describe, expect, it } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'

describe('refreshLog.queries.recentForUser', () => {
  it('returns log rows newest-first', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const subId = await t.run(async (ctx) => {
      return await ctx.db.insert('subscriptions', {
        userId,
        email: 'a@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'cron',
      outcome: 'success',
      at: 1000,
    })
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'manual',
      outcome: 'failure',
      error: 'http 503',
      at: 2000,
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.refreshLog.queries.recentForUser, {
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(result.page.map((r) => r.outcome)).toEqual(['failure', 'success'])
  })

  /**
   * Replaces the prior "does not return another user's rows" assertion.
   * Under the shared-vault contract, alice CAN see bob's rows. The earlier
   * assertion codified the bug we are now fixing.
   */
  it("returns other users' rows merged with the caller's, newest-first", async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const aliceSubId = await t.run(async (ctx) => {
      return await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'alice-sub@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })
    // Bob: a different identity entirely.
    const bobId = await t.run(async (ctx) => {
      return await ctx.db.insert('users', {
        externalId: 'user_bob_zzz',
        name: 'Bob',
        primaryEmail: 'bob@example.com',
        otherEmails: [],
      })
    })
    const bobSubId = await t.run(async (ctx) => {
      return await ctx.db.insert('subscriptions', {
        userId: bobId,
        email: 'bob-sub@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    await t.mutation(internal.refreshLog.mutations.insert, {
      userId: aliceId,
      subscriptionId: aliceSubId,
      triggeredBy: 'cron',
      outcome: 'success',
      at: 1000,
    })
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId: bobId,
      subscriptionId: bobSubId,
      triggeredBy: 'manual',
      outcome: 'failure',
      error: 'http 503',
      at: 2000,
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.refreshLog.queries.recentForUser, {
      paginationOpts: { numItems: 10, cursor: null },
    })
    // Both rows surface (newest first), regardless of which user owns them.
    expect(result.page).toHaveLength(2)
    expect(result.page.map((r) => r.outcome)).toEqual(['failure', 'success'])
    expect(result.page.map((r) => r.userId).sort()).toEqual([aliceId, bobId].sort())
  })
})

describe('refreshLog.queries.recentForSubscription', () => {
  it('returns rows for a subscription owned by a different user (shared vault)', async () => {
    const t = vault()
    // Alice is the caller (TEST_IDENTITY). Bob owns the subscription.
    const aliceId = await seedUser(t)
    void aliceId
    const bobId = await t.run(async (ctx) => {
      return await ctx.db.insert('users', {
        externalId: 'user_bob_zzz',
        name: 'Bob',
        primaryEmail: 'bob@example.com',
        otherEmails: [],
      })
    })
    const bobSubId = await t.run(async (ctx) => {
      return await ctx.db.insert('subscriptions', {
        userId: bobId,
        email: 'bob-sub@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    await t.mutation(internal.refreshLog.mutations.insert, {
      userId: bobId,
      subscriptionId: bobSubId,
      triggeredBy: 'cron',
      outcome: 'success',
      at: 1000,
    })
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId: bobId,
      subscriptionId: bobSubId,
      triggeredBy: 'manual',
      outcome: 'failure',
      error: 'http 503',
      at: 2000,
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.refreshLog.queries.recentForSubscription, {
      subscriptionId: bobSubId,
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(result.page.map((r) => r.outcome)).toEqual(['failure', 'success'])
  })
})
