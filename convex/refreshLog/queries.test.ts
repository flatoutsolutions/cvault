/**
 * Spec: §5 (refreshLog feed) + §8 (`/dashboard/audit` route).
 */
import { describe, expect, it } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'

describe('refreshLog.queries.recentForUser', () => {
  it('returns log rows for the authenticated user newest-first', async () => {
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

    const rows = await t.withIdentity(TEST_IDENTITY).query(api.refreshLog.queries.recentForUser, {
      limit: 10,
    })
    expect(rows.map((r) => r.outcome)).toEqual(['failure', 'success'])
  })

  it("does not return another user's rows", async () => {
    const t = vault()
    const aliceId = await seedUser(t)
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
      userId: bobId,
      subscriptionId: bobSubId,
      triggeredBy: 'cron',
      outcome: 'success',
      at: 1000,
    })

    void aliceId
    const rows = await t.withIdentity(TEST_IDENTITY).query(api.refreshLog.queries.recentForUser, {
      limit: 10,
    })
    expect(rows).toHaveLength(0)
  })
})
