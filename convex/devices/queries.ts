import { v } from 'convex/values'
import { internalQuery } from '../_generated/server'
import { authenticatedQuery } from '../utils/auth'

const deviceRow = v.object({
  machineId: v.string(),
  label: v.optional(v.string()),
  lastSeenAt: v.number(),
  revokedAt: v.optional(v.number()),
})

/** Vault-wide list of devices (shared vault). */
export const listForUser = authenticatedQuery({
  args: {},
  returns: v.array(deviceRow),
  handler: async (ctx) => {
    const rows = await ctx.db.query('devices').collect()
    return rows.map((r) => ({
      machineId: r.machineId,
      ...(r.label !== undefined ? { label: r.label } : {}),
      lastSeenAt: r.lastSeenAt,
      ...(r.revokedAt !== undefined ? { revokedAt: r.revokedAt } : {}),
    }))
  },
})

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
