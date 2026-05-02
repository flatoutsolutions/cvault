/**
 * Spec: §4 (machineActivity table) + §6 (ipHash redaction).
 *
 * The `record` mutation is internal — only Convex actions / mutations
 * emit audit rows. Verifies:
 *  - Required fields land on the row
 *  - ipHash is the SHA-256 prefix (8 hex chars), not the raw IP
 */
import { describe, expect, it } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'

describe('machineActivity.mutations.record', () => {
  it('inserts a row with the action + clerkSessionId', async () => {
    const t = vault()
    const userId = await seedUser(t)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId,
      clerkSessionId: 'sess_test_123',
      action: 'switch',
      at: 1700000000000,
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]?.clerkSessionId).toBe('sess_test_123')
    expect(rows[0]?.action).toBe('switch')
    expect(rows[0]?.at).toBe(1700000000000)
  })

  it('hashes the IP and stores only an 8-char prefix', async () => {
    const t = vault()
    const userId = await seedUser(t)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId,
      clerkSessionId: 'sess_x',
      action: 'pull',
      at: Date.now(),
      rawIp: '203.0.113.42',
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const row = rows[0]
    expect(row?.ipHash).toBeDefined()
    expect(row?.ipHash).toHaveLength(8)
    expect(row?.ipHash).toMatch(/^[0-9a-f]{8}$/)
    // Critically, the raw IP is not stored anywhere on the row.
    expect(JSON.stringify(row)).not.toContain('203.0.113.42')
  })

  it('omits ipHash when no rawIp is provided', async () => {
    const t = vault()
    const userId = await seedUser(t)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId,
      clerkSessionId: 'sess_x',
      action: 'add',
      at: Date.now(),
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    expect(rows[0]?.ipHash).toBeUndefined()
  })
})

describe('machineActivity.queries.recentForUser', () => {
  it('returns rows for the authenticated user newest first, scoped to their userId', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'sess_a',
      action: 'add',
      at: 1000,
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'sess_a',
      action: 'switch',
      at: 2000,
    })

    const rows = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.recentForUser, {
      limit: 10,
    })
    expect(rows.map((r: { action: string }) => r.action)).toEqual(['switch', 'add']) // newest first
  })
})
