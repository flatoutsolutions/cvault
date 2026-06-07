import { v } from 'convex/values'

import { internalMutation } from '../_generated/server'

export const revoke = internalMutation({
  args: { sid: v.string(), machineId: v.optional(v.string()), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { sid, machineId, at }) => {
    const existing = await ctx.db
      .query('revokedSessions')
      .withIndex('bySid', (q) => q.eq('sid', sid))
      .unique()
    if (existing === null) {
      await ctx.db.insert('revokedSessions', { sid, at, ...(machineId !== undefined ? { machineId } : {}) })
    }
    return null
  },
})
