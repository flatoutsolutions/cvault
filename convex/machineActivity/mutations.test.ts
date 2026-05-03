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

  /**
   * `machineLabel` is the user-visible identifier for a machine in the
   * dashboard's "Machines" section. The CLI defaults it to `os.hostname()`
   * at session creation; the user can override via `cvault login --label`.
   * Stored on every machineActivity row so the dashboard's most-recent
   * lookup picks it up without a join.
   */
  it('stores machineLabel when provided', async () => {
    const t = vault()
    const userId = await seedUser(t)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId,
      clerkSessionId: 'sess_label',
      action: 'add',
      at: Date.now(),
      machineLabel: 'office-laptop',
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    expect(rows[0]?.machineLabel).toBe('office-laptop')
  })

  it('omits machineLabel when not provided (backward compat with legacy callers)', async () => {
    const t = vault()
    const userId = await seedUser(t)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId,
      clerkSessionId: 'sess_no_label',
      action: 'add',
      at: Date.now(),
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    expect(rows[0]?.machineLabel).toBeUndefined()
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

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.recentForUser, {
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(result.page.map((r: { action: string }) => r.action)).toEqual(['switch', 'add']) // newest first
  })
})

describe('machineActivity.queries.distinctSessionsForUser', () => {
  /**
   * The dashboard's "Machines" section reads from this query. Each row
   * is one Clerk session; the user-visible identifier is `machineLabel`.
   * The mapping from sessionId → label is captured on every audit row,
   * and we surface the most-recent label per session — so renaming a
   * machine via `cvault login --label` is reflected on the next refresh.
   */
  it('returns the most-recent machineLabel per session', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    // Session A: two rows, the most-recent one carries a renamed label.
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'sess_a',
      action: 'add',
      at: 1000,
      machineLabel: 'old-name',
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'sess_a',
      action: 'refresh',
      at: 2000,
      machineLabel: 'new-name',
    })

    // Session B: only one row, with a label.
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'sess_b',
      action: 'add',
      at: 1500,
      machineLabel: 'sole-row',
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.distinctSessionsForUser, {})
    const bySession = new Map(result.map((r) => [r.clerkSessionId, r]))
    expect(bySession.get('sess_a')?.machineLabel).toBe('new-name')
    expect(bySession.get('sess_b')?.machineLabel).toBe('sole-row')
  })

  it('returns machineLabel undefined when the session has no labeled rows', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'sess_legacy',
      action: 'add',
      at: 1000,
      // no machineLabel — legacy / pre-feature row
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.distinctSessionsForUser, {})
    expect(result).toHaveLength(1)
    expect(result[0]?.machineLabel).toBeUndefined()
  })
})
