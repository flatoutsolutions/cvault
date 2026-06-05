/**
 * CVLT-3 staged migration: clerkSessionId → machineId on machineActivity.
 *
 * Verifies:
 *  - backfillMachineId copies clerkSessionId → machineId on legacy rows
 *  - it leaves already-migrated (machineId-bearing) rows untouched (idempotent)
 *  - recentForUser / getStatus do not crash on legacy rows missing machineId
 *    (the read-time coalesce keeps the `machineId: v.string()` validator happy)
 */
import { describe, expect, it } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'

/** Insert a pre-PKCE row directly (clerkSessionId, no machineId). */
async function insertLegacyRow(
  t: ReturnType<typeof vault>,
  userId: Id<'users'>,
  clerkSessionId: string,
  at: number,
  extra: { subscriptionId?: Id<'subscriptions'>; ipHash?: string } = {}
): Promise<Id<'machineActivity'>> {
  return await t.run(async (ctx) =>
    ctx.db.insert('machineActivity', {
      userId,
      clerkSessionId,
      action: 'pull',
      at,
      ...extra,
    })
  )
}

describe('machineActivity.migrations.backfillMachineId', () => {
  it('copies clerkSessionId → machineId on legacy rows and reports counts', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const legacyId = await insertLegacyRow(t, userId, 'sess_legacy_1', 1000)

    const result = await t.mutation(internal.machineActivity.migrations.backfillMachineId, {})
    expect(result.patched).toBe(1)
    expect(result.done).toBe(true)

    const row = await t.run(async (ctx) => ctx.db.get(legacyId))
    expect(row?.machineId).toBe('sess_legacy_1')
    // clerkSessionId is retained until migration step 3.
    expect(row?.clerkSessionId).toBe('sess_legacy_1')
  })

  it('is idempotent — re-running patches nothing and skips machineId-bearing rows', async () => {
    const t = vault()
    const userId = await seedUser(t)
    await insertLegacyRow(t, userId, 'sess_legacy_2', 1000)
    await t.mutation(internal.machineActivity.mutations.record, {
      userId,
      machineId: 'mach-new',
      action: 'login',
      at: 2000,
    })

    const first = await t.mutation(internal.machineActivity.migrations.backfillMachineId, {})
    expect(first.patched).toBe(1) // only the legacy row

    const second = await t.mutation(internal.machineActivity.migrations.backfillMachineId, {})
    expect(second.patched).toBe(0) // nothing left to do
  })
})

describe('reads tolerate legacy rows during the migration window', () => {
  it('recentForUser returns a legacy row with machineId coalesced from clerkSessionId', async () => {
    const t = vault()
    const userId = await seedUser(t)
    await insertLegacyRow(t, userId, 'sess_audit_legacy', 1000, { ipHash: 'deadbeef' })

    const result = await t
      .withIdentity(TEST_IDENTITY)
      .query(api.machineActivity.queries.recentForUser, { paginationOpts: { numItems: 10, cursor: null } })

    expect(result.page).toHaveLength(1)
    expect(result.page[0]?.machineId).toBe('sess_audit_legacy')
    expect(result.page[0]?.ipHash).toBe('deadbeef')
    // The undeclared clerkSessionId field is dropped from the wire shape.
    expect((result.page[0] as Record<string, unknown>).clerkSessionId).toBeUndefined()
  })
})
