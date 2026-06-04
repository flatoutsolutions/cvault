import { v } from 'convex/values'

import { internalQuery } from '../_generated/server'

export const isRevoked = internalQuery({
  args: { sid: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { sid }) => {
    const row = await ctx.db
      .query('revokedSessions')
      .withIndex('bySid', (q) => q.eq('sid', sid))
      .unique()
    return row !== null
  },
})
