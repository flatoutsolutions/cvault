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
   * The dashboard's "Machines" section reads from this query. Two
   * grouping behaviors:
   *
   *  - Real Clerk session ids: collapse on sid alone — one row per sid.
   *    The most-recent label wins (rows are `.order('desc')` by `at`).
   *    A relabel-in-place via `cvault login --label new` should not
   *    leave a ghost row for the old label.
   *
   *  - The 'unknown-session' sentinel: split per (sentinel, label).
   *    Cron, server-context writes, and pre-fix CLIs all write the
   *    sentinel; collapsing them into one row would lump every machine's
   *    server-side activity into a single misleading entry. Splitting
   *    by label preserves at least the per-machine identity even though
   *    the sid is missing.
   */
  it('collapses real sids to one row using the most-recent label', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    // Session A: two rows under the same sid with different labels.
    // The most-recent (at=2000) wins.
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
    // One row per real sid (sess_a + sess_b = 2 rows).
    expect(result).toHaveLength(2)
    const sessA = result.find((r) => r.clerkSessionId === 'sess_a')
    expect(sessA?.machineLabel).toBe('new-name') // most-recent wins
    const sessB = result.find((r) => r.clerkSessionId === 'sess_b')
    expect(sessB?.machineLabel).toBe('sole-row')
    // Real sids are always revocable.
    expect(result.every((r) => r.revocable)).toBe(true)
  })

  it('splits the sentinel into one row per machineLabel', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    // Two cron / server-context writes from notional different machines —
    // both wrote the sentinel because no real Clerk session was available
    // at the call site. Splitting by label keeps them distinguishable on
    // the dashboard rather than collapsing into a single row.
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'unknown-session',
      action: 'pull',
      at: 3000,
      machineLabel: 'cron-server-a',
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'unknown-session',
      action: 'pull',
      at: 4000,
      machineLabel: 'cron-server-b',
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.distinctSessionsForUser, {})
    const sentinelRows = result.filter((r) => r.clerkSessionId === 'unknown-session')
    expect(sentinelRows).toHaveLength(2)
    // None of the sentinel rows are revocable — there's no live Clerk
    // session to call BAPI against.
    expect(sentinelRows.every((r) => !r.revocable)).toBe(true)
    const labels = sentinelRows.map((r) => r.machineLabel).sort()
    expect(labels).toEqual(['cron-server-a', 'cron-server-b'])
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

  it('skips rows whose clerkSessionId is the empty string', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    // Empty sid is structurally identical to "no session" and shouldn't
    // render as a clickable machine. Defense-in-depth: today no caller
    // writes empty strings, but a future bug shouldn't leak a phantom
    // row to the dashboard.
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: '',
      action: 'pull',
      at: 1000,
      machineLabel: 'should-be-hidden',
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'sess_real',
      action: 'add',
      at: 2000,
      machineLabel: 'should-show',
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.distinctSessionsForUser, {})
    expect(result).toHaveLength(1)
    expect(result[0]?.clerkSessionId).toBe('sess_real')
  })

  it('rejects the sentinel argument on recentForSession (returns empty page)', async () => {
    // Otherwise a deeplink to /dashboard/machines/unknown-session would
    // show every cron-driven row mixed across machines.
    const t = vault()
    const aliceId = await seedUser(t)
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'unknown-session',
      action: 'pull',
      at: 1000,
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.recentForSession, {
      clerkSessionId: 'unknown-session',
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(result.page).toEqual([])
    expect(result.isDone).toBe(true)
  })
})
