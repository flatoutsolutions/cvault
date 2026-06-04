import { v } from 'convex/values'

import { internalMutation } from '../_generated/server'

export const ban = internalMutation({
  args: { externalId: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { externalId, at }) => {
    const existing = await ctx.db
      .query('revokedUsers')
      .withIndex('byExternalId', (q) => q.eq('externalId', externalId))
      .unique()
    if (existing === null) await ctx.db.insert('revokedUsers', { externalId, at })
    return null
  },
})
