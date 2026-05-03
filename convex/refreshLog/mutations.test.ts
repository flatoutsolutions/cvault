/**
 * Spec: cron-spam fix sweep — `reloginRequired` log dedupe.
 *
 * The original failure mode: `findExpiringSubs` kept selecting RT-dead
 * subs every cron tick → `refreshOAuthToken` kept hitting Anthropic →
 * Anthropic kept answering `invalid_grant` → `reloginRequired` rows
 * accumulated forever. Stefan's audit log showed 21+ identical rows
 * within 3.5h.
 *
 * The primary fix is upstream (exclude RT-dead subs from the cron scan,
 * short-circuit in the action itself). This dedupe is defense-in-depth:
 * even if some future caller bypasses both upstream guards and lands a
 * `reloginRequired` insert here within 5 minutes of the previous one for
 * the same sub, we silently drop the duplicate. `failure` and `success`
 * rows are NEVER deduped — they're meaningful per-attempt and the
 * dashboard's audit feed needs them all.
 */
import { describe, expect, it } from 'vitest'

import { seedUser, vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'

async function seedSubForLog(t: ReturnType<typeof vault>, userId: Awaited<ReturnType<typeof seedUser>>) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('subscriptions', {
      userId,
      email: 'log@example.com',
      slot: 1,
      ciphertext: new ArrayBuffer(8),
      nonce: new ArrayBuffer(12),
      expiresAt: Date.now() + 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
      lastRefreshedAt: Date.now(),
    })
  })
}

describe('refreshLog.mutations.insert dedupe', () => {
  it('drops a 2nd reloginRequired insert for the same sub within 5 minutes', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const subId = await seedSubForLog(t, userId)

    const now = Date.now()
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'cron',
      outcome: 'reloginRequired',
      error: 'invalid_grant',
      at: now,
    })
    // 30 seconds later — well within the 5-minute window.
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'cron',
      outcome: 'reloginRequired',
      error: 'invalid_grant (again)',
      at: now + 30_000,
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]?.error).toBe('invalid_grant')
  })

  it('inserts a 2nd reloginRequired after the 5-minute window has elapsed', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const subId = await seedSubForLog(t, userId)

    const now = Date.now()
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'cron',
      outcome: 'reloginRequired',
      at: now,
    })
    // 6 minutes later — past the dedupe window.
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'cron',
      outcome: 'reloginRequired',
      at: now + 6 * 60 * 1000,
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(rows).toHaveLength(2)
  })

  it('does NOT dedupe `failure` rows — every attempt is meaningful', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const subId = await seedSubForLog(t, userId)

    const now = Date.now()
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'cron',
      outcome: 'failure',
      error: 'Anthropic 503 service_unavailable',
      at: now,
    })
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'cron',
      outcome: 'failure',
      error: 'Anthropic 503 service_unavailable (still)',
      at: now + 30_000,
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(rows).toHaveLength(2)
  })

  it('does NOT dedupe `success` rows', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const subId = await seedSubForLog(t, userId)

    const now = Date.now()
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'cron',
      outcome: 'success',
      at: now,
    })
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'cron',
      outcome: 'success',
      at: now + 30_000,
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(rows).toHaveLength(2)
  })

  it('dedupe is per-subscription — two different subs both get their reloginRequired row', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const subA = await seedSubForLog(t, userId)
    const subB = await t.run(async (ctx) =>
      ctx.db.insert('subscriptions', {
        userId,
        email: 'sub-b@example.com',
        slot: 2,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60 * 1000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    )

    const now = Date.now()
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subA,
      triggeredBy: 'cron',
      outcome: 'reloginRequired',
      at: now,
    })
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subB,
      triggeredBy: 'cron',
      outcome: 'reloginRequired',
      at: now + 30_000,
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(rows).toHaveLength(2)
  })
})
