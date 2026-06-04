/**
 * Spec: CVLT-3 — revokedUsers hard-ban denylist mutations.
 *
 * Verifies:
 *  - ban inserts a row keyed by externalId
 *  - a second ban with the same externalId is idempotent (no duplicate rows)
 */
import { describe, expect, it } from 'vitest'

import { vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'

describe('revokedUsers', () => {
  it('ban inserts a row keyed by externalId; second ban is idempotent', async () => {
    const t = vault()
    await t.mutation(internal.revokedUsers.mutations.ban, { externalId: 'user_x', at: 1 })
    await t.mutation(internal.revokedUsers.mutations.ban, { externalId: 'user_x', at: 2 })
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('revokedUsers')
        .withIndex('byExternalId', (q) => q.eq('externalId', 'user_x'))
        .collect()
    )
    expect(rows).toHaveLength(1)
  })
})
