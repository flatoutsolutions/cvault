/**
 * Spec: §5 (queries) + §11 (testing).
 *
 * The `findExpiringSubs` query was removed in v1 (audit fix #5) along
 * with the `refreshExpiringTokens` cron — see
 * `convex/__tests__/scenarios/cronDoesNotPoisonStaleRT.scenario.test.ts`.
 *
 * `listAllActiveSubIds` remains in use by the `pollUsage` cron and is
 * still tested below.
 */
import { describe, expect, it } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'

async function seedSub(
  t: ReturnType<typeof vault>,
  opts: { email: string; expiresAt: number; removedAt?: number; refreshExpiresAt?: number }
) {
  const userId = await seedUser(t, {
    subject: TEST_IDENTITY.subject,
    name: TEST_IDENTITY.name,
    email: TEST_IDENTITY.email,
  }).catch(async () => {
    // Re-using the same user across calls — `seedUser` would try to
    // double-insert. Look up the existing one instead.
    return await t.run(async (ctx) => {
      const existing = await ctx.db
        .query('users')
        .withIndex('byExternalId', (q) => q.eq('externalId', TEST_IDENTITY.subject))
        .unique()
      if (!existing) throw new Error('seedUser raced')
      return existing._id
    })
  })

  return await t.run(async (ctx) => {
    return await ctx.db.insert('subscriptions', {
      userId,
      email: opts.email,
      slot: 1,
      ciphertext: new ArrayBuffer(8),
      nonce: new ArrayBuffer(12),
      expiresAt: opts.expiresAt,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
      lastRefreshedAt: Date.now(),
      ...(opts.removedAt !== undefined ? { removedAt: opts.removedAt } : {}),
      ...(opts.refreshExpiresAt !== undefined ? { refreshExpiresAt: opts.refreshExpiresAt } : {}),
    })
  })
}

describe('subscriptions.internalReads.listAllActiveSubIds', () => {
  it('excludes tombstoned and RT-dead subs', async () => {
    const t = vault()
    const now = Date.now()

    const alive = await seedSub(t, {
      email: 'alive@example.com',
      expiresAt: now + 60 * 60 * 1000,
      refreshExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
    })
    const noRefreshExp = await seedSub(t, {
      email: 'legacy@example.com',
      expiresAt: now + 60 * 60 * 1000,
    })
    // Soft-removed — already excluded pre-fix.
    await seedSub(t, {
      email: 'gone@example.com',
      expiresAt: now + 60 * 60 * 1000,
      removedAt: now - 1000,
    })
    // RT dead — the new exclusion. Polling usage with a dead access
    // token is wasted work; the next refresh cycle won't be able to
    // recover it without user re-capture either.
    await seedSub(t, {
      email: 'dead@example.com',
      expiresAt: now + 60 * 60 * 1000,
      refreshExpiresAt: now - 60 * 1000,
    })

    const result = await t.query(internal.subscriptions.internalReads.listAllActiveSubIds, {})
    const ids = result.map((r) => r.subId).sort()
    expect(ids).toEqual([alive, noRefreshExp].sort())
  })
})

describe('subscriptions.internalReads.listSubsExpiringWithin', () => {
  it('returns only active, RT-alive subs whose token expires within the window', async () => {
    const t = vault()
    const now = Date.now()
    const within = 5 * 60 * 1000

    // Inside the window → included.
    const nearA = await seedSub(t, {
      email: 'near-a@example.com',
      expiresAt: now + 60 * 1000,
      refreshExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
    })
    const nearB = await seedSub(t, {
      email: 'near-b@example.com',
      expiresAt: now + 4 * 60 * 1000,
      refreshExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
    })
    // Outside the window → excluded (this is the whole point: the cron must
    // NOT acquire a lease on far-from-expiry subs every tick).
    await seedSub(t, {
      email: 'far@example.com',
      expiresAt: now + 60 * 60 * 1000,
      refreshExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
    })
    // Tombstoned → excluded even though near expiry.
    await seedSub(t, { email: 'gone@example.com', expiresAt: now + 60 * 1000, removedAt: now - 1000 })
    // RT dead → excluded (re-driving Anthropic would just earn another
    // invalid_grant; recovery is user re-capture).
    await seedSub(t, {
      email: 'dead@example.com',
      expiresAt: now + 60 * 1000,
      refreshExpiresAt: now - 60 * 1000,
    })

    const result = await t.query(internal.subscriptions.internalReads.listSubsExpiringWithin, {
      withinMs: within,
    })
    const ids = result.map((r) => r.subId).sort()
    expect(ids).toEqual([nearA, nearB].sort())
  })
})
