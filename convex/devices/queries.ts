import { v } from 'convex/values'
import { internalQuery } from '../_generated/server'

export const getForUser = internalQuery({
  args: { userId: v.id('users'), machineId: v.string() },
  returns: v.union(v.object({ _id: v.id('devices'), grantRef: v.optional(v.string()) }), v.null()),
  handler: async (ctx, { userId, machineId }) => {
    const row = await ctx.db
      .query('devices')
      .withIndex('byUserAndMachine', (q) => q.eq('userId', userId).eq('machineId', machineId))
      .unique()
    return row === null ? null : { _id: row._id, ...(row.grantRef !== undefined ? { grantRef: row.grantRef } : {}) }
  },
})
