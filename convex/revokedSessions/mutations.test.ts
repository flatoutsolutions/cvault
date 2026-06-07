/**
 * CVLT-3: revokedSessions denylist — revoke is idempotent.
 */
import { describe, expect, it } from 'vitest'

import { vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'

describe('revokedSessions', () => {
  it('revoke inserts a row keyed by sid; second revoke is idempotent', async () => {
    const t = vault()
    await t.mutation(internal.revokedSessions.mutations.revoke, { sid: 'sess_abc', at: 1 })
    await t.mutation(internal.revokedSessions.mutations.revoke, { sid: 'sess_abc', at: 2 })
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('revokedSessions')
        .withIndex('bySid', (q) => q.eq('sid', 'sess_abc'))
        .collect()
    )
    expect(rows).toHaveLength(1)
    // First insert wins (idempotent — no update on second call)
    expect(rows[0]?.at).toBe(1)
  })

  it('isRevoked returns true after revoke', async () => {
    const t = vault()
    await t.mutation(internal.revokedSessions.mutations.revoke, { sid: 'sess_xyz', at: 100 })
    const revoked = await t.query(internal.revokedSessions.queries.isRevoked, { sid: 'sess_xyz' })
    expect(revoked).toBe(true)
  })

  it('isRevoked returns false for an unknown sid', async () => {
    const t = vault()
    const revoked = await t.query(internal.revokedSessions.queries.isRevoked, { sid: 'sess_unknown' })
    expect(revoked).toBe(false)
  })

  it('stores machineId when provided', async () => {
    const t = vault()
    await t.mutation(internal.revokedSessions.mutations.revoke, {
      sid: 'sess_with_machine',
      machineId: 'machine-uuid-1',
      at: 500,
    })
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('revokedSessions')
        .withIndex('bySid', (q) => q.eq('sid', 'sess_with_machine'))
        .collect()
    )
    expect(rows[0]?.machineId).toBe('machine-uuid-1')
  })
})
