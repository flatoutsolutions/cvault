import { v } from 'convex/values'

import { internalQuery } from '../_generated/server'

export const isRevoked = internalQuery({
  args: { externalId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { externalId }) => {
    const row = await ctx.db
      .query('revokedUsers')
      .withIndex('byExternalId', (q) => q.eq('externalId', externalId))
      .unique()
    return row !== null
  },
})
