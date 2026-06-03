/**
 * Spec: CVLT-3 — devices upsert + markRevoked mutations.
 *
 * Verifies:
 *  - upsert creates a device row on first sight
 *  - upsert bumps lastSeenAt + clears revokedAt on subsequent calls
 *  - markRevoked sets revokedAt on the matching (user, machine) row
 *  - a subsequent upsert after markRevoked clears revokedAt
 */
import { describe, expect, it } from 'vitest'

import { internal } from '../_generated/api'
import { vault, seedUser } from '../__tests__/helpers'

describe('devices mutations', () => {
  it('upsert creates then updates lastSeenAt for the same (user, machine)', async () => {
    const t = vault()
    const userId = await seedUser(t)
    await t.mutation(internal.devices.mutations.upsert, { userId, machineId: 'm-1', label: 'air', at: 1000 })
    await t.mutation(internal.devices.mutations.upsert, { userId, machineId: 'm-1', label: 'air', at: 2000 })
    const rows = await t.run(async (ctx) => ctx.db.query('devices').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]?.lastSeenAt).toBe(2000)
    expect(rows[0]?.createdAt).toBe(1000)
  })

  it('markRevoked sets revokedAt; a later upsert clears it', async () => {
    const t = vault()
    const userId = await seedUser(t)
    await t.mutation(internal.devices.mutations.upsert, { userId, machineId: 'm-1', label: 'air', at: 1000 })
    await t.mutation(internal.devices.mutations.markRevoked, { userId, machineId: 'm-1', at: 5000 })
    let row = await t.run(async (ctx) =>
      ctx.db
        .query('devices')
        .withIndex('byUserAndMachine', (q) => q.eq('userId', userId).eq('machineId', 'm-1'))
        .unique()
    )
    expect(row?.revokedAt).toBe(5000)
    await t.mutation(internal.devices.mutations.upsert, { userId, machineId: 'm-1', label: 'air', at: 6000 })
    row = await t.run(async (ctx) =>
      ctx.db
        .query('devices')
        .withIndex('byUserAndMachine', (q) => q.eq('userId', userId).eq('machineId', 'm-1'))
        .unique()
    )
    expect(row?.revokedAt).toBeUndefined()
  })
})
