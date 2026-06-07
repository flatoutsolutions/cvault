/**
 * Reset migration: clearTable drains a clearable table, leaves kept tables
 * (users) untouched, and is idempotent. The restricted `table` union also
 * means kept tables are unreachable — asserted indirectly by the validator
 * rejecting a non-clearable name.
 */
import { describe, expect, it } from 'vitest'

import { seedUser, vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'

describe('migrations.resetStaleData.clearTable', () => {
  it('deletes all rows in a clearable table but leaves users intact', async () => {
    const t = vault()
    const userId = await seedUser(t)

    // Seed a few rows in a clearable table (revokedUsers is the simplest shape).
    await t.run(async (ctx) => {
      await ctx.db.insert('revokedUsers', { externalId: 'ext_a', at: 1 })
      await ctx.db.insert('revokedUsers', { externalId: 'ext_b', at: 2 })
      await ctx.db.insert('revokedUsers', { externalId: 'ext_c', at: 3 })
    })

    const res = await t.mutation(internal.migrations.resetStaleData.clearTable, { table: 'revokedUsers' })
    expect(res.deleted).toBe(3)
    expect(res.done).toBe(true)

    const remaining = await t.run(async (ctx) => ctx.db.query('revokedUsers').collect())
    expect(remaining).toHaveLength(0)

    // users must be untouched.
    const user = await t.run(async (ctx) => ctx.db.get('users', userId))
    expect(user).not.toBeNull()
  })

  it('is idempotent — clearing an already-empty table deletes 0 and is done', async () => {
    const t = vault()
    const res = await t.mutation(internal.migrations.resetStaleData.clearTable, { table: 'rateLimit' })
    expect(res).toEqual({ deleted: 0, done: true })
  })

  it('resetStaleData drains every clearable table and reports per-table counts', async () => {
    const t = vault()
    const userId = await seedUser(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('revokedSessions', { sid: 's1', at: 1 })
      await ctx.db.insert('revokedUsers', { externalId: 'ext_a', at: 1 })
    })

    const summary = await t.action(internal.migrations.resetStaleData.resetStaleData, {})
    expect(summary.revokedSessions).toBe(1)
    expect(summary.revokedUsers).toBe(1)
    // All clearable tables are reported, even empty ones (count 0).
    expect(summary.subscriptions).toBe(0)

    const sessions = await t.run(async (ctx) => ctx.db.query('revokedSessions').collect())
    expect(sessions).toHaveLength(0)
    // users still present.
    expect(await t.run(async (ctx) => ctx.db.get('users', userId))).not.toBeNull()
  })
})
