/**
 * Spec: §4 (machineActivity table) + §6 (ipHash redaction).
 *
 * The `record` mutation is internal — only Convex actions / mutations
 * emit audit rows. Verifies:
 *  - Required fields land on the row
 *  - ipHash is the SHA-256 prefix (8 hex chars), not the raw IP
 */
import { describe, expect, it } from 'vitest'

import { SECOND_IDENTITY, TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
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
  // Architectural intent — shared vault. Per `convex/utils/users.ts:3-7`,
  // any authenticated identity reads any audit row. The legacy "scoped to
  // their userId" assertion was the bug.

  it('returns rows for the authenticated user newest first', async () => {
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
    expect(result.page.map((r: { action: string }) => r.action)).toEqual(['switch', 'add'])
  })

  it('returns rows from every user — shared vault visibility, sorted by at desc', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    // Interleaved timestamps across users so a per-user filter would
    // return only half the rows AND in the wrong order.
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'sess_alice',
      action: 'add',
      at: 1000,
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: bobId,
      clerkSessionId: 'sess_bob',
      action: 'pull',
      at: 2000,
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'sess_alice',
      action: 'switch',
      at: 3000,
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.recentForUser, {
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(result.page.map((r) => r.at)).toEqual([3000, 2000, 1000])
    expect(result.page.map((r) => r.clerkSessionId)).toEqual(['sess_alice', 'sess_bob', 'sess_alice'])
  })

  it('returns the same set regardless of which user calls it', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'sess_a',
      action: 'add',
      at: 1000,
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: bobId,
      clerkSessionId: 'sess_b',
      action: 'pull',
      at: 2000,
    })

    const fromAlice = await t
      .withIdentity(TEST_IDENTITY)
      .query(api.machineActivity.queries.recentForUser, { paginationOpts: { numItems: 10, cursor: null } })
    const fromBob = await t
      .withIdentity(SECOND_IDENTITY)
      .query(api.machineActivity.queries.recentForUser, { paginationOpts: { numItems: 10, cursor: null } })

    expect(fromAlice.page.map((r) => r.clerkSessionId)).toEqual(['sess_b', 'sess_a'])
    expect(fromAlice.page).toEqual(fromBob.page)
  })
})

describe('machineActivity.queries.recentForSession', () => {
  // Shared-vault: the audit drilldown for a sid must surface rows from
  // any user that touched that sid. (Sids are unique per Clerk session,
  // but the table is shared.)
  it('returns rows for a session even when the caller is a different user', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    // Bob's session writes two rows.
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: bobId,
      clerkSessionId: 'sess_bob',
      action: 'add',
      at: 1000,
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: bobId,
      clerkSessionId: 'sess_bob',
      action: 'pull',
      at: 2000,
    })
    // Alice has unrelated rows under a different sid.
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'sess_alice',
      action: 'add',
      at: 1500,
    })

    // Auth as Alice, drill into bob's session.
    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.recentForSession, {
      clerkSessionId: 'sess_bob',
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(result.page.map((r) => r.at)).toEqual([2000, 1000])
    expect(result.page.every((r) => r.clerkSessionId === 'sess_bob')).toBe(true)
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

  it('returns sessions from every user — shared vault visibility', async () => {
    // Architectural intent — `distinctSessionsForUser` powers the
    // dashboard's Machines view. In shared mode any allowlisted user
    // sees every machine that has touched the vault.
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      clerkSessionId: 'sess_alice',
      action: 'add',
      at: 1000,
      machineLabel: 'alice-laptop',
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: bobId,
      clerkSessionId: 'sess_bob',
      action: 'add',
      at: 2000,
      machineLabel: 'bob-desktop',
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.distinctSessionsForUser, {})
    expect(result).toHaveLength(2)
    const sids = result.map((r) => r.clerkSessionId).sort()
    expect(sids).toEqual(['sess_alice', 'sess_bob'])
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
