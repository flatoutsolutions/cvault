/**
 * Spec: §4 (machineActivity table) + §6 (ipHash redaction).
 * CVLT-3: field renamed clerkSessionId → machineId; sentinel/revocable
 * logic removed; recentForSession → recentForMachine.
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
  it('inserts a row with the action + machineId', async () => {
    const t = vault()
    const userId = await seedUser(t)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId,
      machineId: 'mach-uuid-123',
      action: 'switch',
      at: 1700000000000,
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]?.machineId).toBe('mach-uuid-123')
    expect(rows[0]?.action).toBe('switch')
    expect(rows[0]?.at).toBe(1700000000000)
  })

  it('hashes the IP and stores only an 8-char prefix', async () => {
    const t = vault()
    const userId = await seedUser(t)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId,
      machineId: 'mach-x',
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
      machineId: 'mach-x',
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
      machineId: 'mach-label',
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
      machineId: 'mach-no-label',
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
      machineId: 'mach-a',
      action: 'add',
      at: 1000,
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      machineId: 'mach-a',
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
      machineId: 'mach-alice',
      action: 'add',
      at: 1000,
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: bobId,
      machineId: 'mach-bob',
      action: 'pull',
      at: 2000,
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      machineId: 'mach-alice',
      action: 'switch',
      at: 3000,
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.recentForUser, {
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(result.page.map((r) => r.at)).toEqual([3000, 2000, 1000])
    expect(result.page.map((r) => r.machineId)).toEqual(['mach-alice', 'mach-bob', 'mach-alice'])
  })

  it('returns the same set regardless of which user calls it', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      machineId: 'mach-a',
      action: 'add',
      at: 1000,
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: bobId,
      machineId: 'mach-b',
      action: 'pull',
      at: 2000,
    })

    const fromAlice = await t
      .withIdentity(TEST_IDENTITY)
      .query(api.machineActivity.queries.recentForUser, { paginationOpts: { numItems: 10, cursor: null } })
    const fromBob = await t
      .withIdentity(SECOND_IDENTITY)
      .query(api.machineActivity.queries.recentForUser, { paginationOpts: { numItems: 10, cursor: null } })

    expect(fromAlice.page.map((r) => r.machineId)).toEqual(['mach-b', 'mach-a'])
    expect(fromAlice.page).toEqual(fromBob.page)
  })
})

describe('machineActivity.queries.recentForMachine', () => {
  // Shared-vault: the audit drilldown for a machineId must surface rows from
  // any user that touched that machine. (machineIds are unique per device.)
  it('returns rows for a machine even when the caller is a different user', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    // Bob's machine writes two rows.
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: bobId,
      machineId: 'mach-bob',
      action: 'add',
      at: 1000,
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: bobId,
      machineId: 'mach-bob',
      action: 'pull',
      at: 2000,
    })
    // Alice has unrelated rows under a different machineId.
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      machineId: 'mach-alice',
      action: 'add',
      at: 1500,
    })

    // Auth as Alice, drill into Bob's machine.
    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.recentForMachine, {
      machineId: 'mach-bob',
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(result.page.map((r) => r.at)).toEqual([2000, 1000])
    expect(result.page.every((r) => r.machineId === 'mach-bob')).toBe(true)
  })
})

describe('machineActivity.queries.distinctSessionsForUser', () => {
  /**
   * The dashboard's "Machines" section reads from this query.
   * Grouping: collapse on machineId — one row per distinct machineId.
   * Rows are `.order('desc')` by `at`, so the FIRST row per machineId is
   * the most-recent one and its `machineLabel` is what surfaces.
   *
   * CVLT-3: sentinel / unknown-session concept dropped. No `revocable` field.
   */
  it('collapses identical machineIds to one row using the most-recent label', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    // Machine A: two rows under the same machineId with different labels.
    // The most-recent (at=2000) wins.
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      machineId: 'mach-a',
      action: 'add',
      at: 1000,
      machineLabel: 'old-name',
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      machineId: 'mach-a',
      action: 'refresh',
      at: 2000,
      machineLabel: 'new-name',
    })

    // Machine B: only one row, with a label.
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      machineId: 'mach-b',
      action: 'add',
      at: 1500,
      machineLabel: 'sole-row',
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.distinctSessionsForUser, {})
    // One row per machineId (mach-a + mach-b = 2 rows).
    expect(result).toHaveLength(2)
    const machA = result.find((r) => r.machineId === 'mach-a')
    expect(machA?.machineLabel).toBe('new-name') // most-recent wins
    const machB = result.find((r) => r.machineId === 'mach-b')
    expect(machB?.machineLabel).toBe('sole-row')
    // No revocable field in the new shape.
    expect(result.every((r) => !('revocable' in r))).toBe(true)
  })

  it('returns machineLabel undefined when the machine has no labeled rows', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      machineId: 'mach-legacy',
      action: 'add',
      at: 1000,
      // no machineLabel — legacy / pre-feature row
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.distinctSessionsForUser, {})
    expect(result).toHaveLength(1)
    expect(result[0]?.machineLabel).toBeUndefined()
  })

  it('skips rows whose machineId is the empty string', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    // Empty machineId shouldn't render as a clickable machine. Defense-in-depth.
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      machineId: '',
      action: 'pull',
      at: 1000,
      machineLabel: 'should-be-hidden',
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      machineId: 'mach-real',
      action: 'add',
      at: 2000,
      machineLabel: 'should-show',
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.distinctSessionsForUser, {})
    expect(result).toHaveLength(1)
    expect(result[0]?.machineId).toBe('mach-real')
  })

  it('returns machines from every user — shared vault visibility', async () => {
    // Architectural intent — `distinctSessionsForUser` powers the
    // dashboard's Machines view. In shared mode any allowlisted user
    // sees every machine that has touched the vault.
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    await t.mutation(internal.machineActivity.mutations.record, {
      userId: aliceId,
      machineId: 'mach-alice',
      action: 'add',
      at: 1000,
      machineLabel: 'alice-laptop',
    })
    await t.mutation(internal.machineActivity.mutations.record, {
      userId: bobId,
      machineId: 'mach-bob',
      action: 'add',
      at: 2000,
      machineLabel: 'bob-desktop',
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.machineActivity.queries.distinctSessionsForUser, {})
    expect(result).toHaveLength(2)
    const machineIds = result.map((r) => r.machineId).sort()
    expect(machineIds).toEqual(['mach-alice', 'mach-bob'])
  })
})
