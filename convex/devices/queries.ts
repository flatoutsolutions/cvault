import { v } from 'convex/values'

import { internalQuery } from '../_generated/server'
import { authenticatedQuery } from '../utils/auth'

const deviceRow = v.object({
  machineId: v.string(),
  label: v.optional(v.string()),
  lastSeenAt: v.number(),
  lastIpHash: v.optional(v.string()),
  revokedAt: v.optional(v.number()),
})

/** Vault-wide list of devices (shared vault). */
export const listForUser = authenticatedQuery({
  args: {},
  returns: v.array(deviceRow),
  handler: async (ctx) => {
    const rows = await ctx.db.query('devices').collect()
    return await Promise.all(
      rows.map(async (r) => {
        // IP hash is captured by the `/api/cli/sync` HTTP endpoint (the only
        // caller with a real Request → x-forwarded-for). That endpoint keys
        // its audit rows by the Clerk session id (sid), not the device UUID.
        // The device row stores its login sid (stable across refresh), so we
        // join device.sid → the most-recent machineActivity row carrying an
        // ipHash to surface the machine's last-seen IP. No CLI/schema change.
        let lastIpHash: string | undefined
        const sid = r.sid
        if (sid !== undefined) {
          const recent = await ctx.db
            .query('machineActivity')
            .withIndex('byMachineAndAt', (q) => q.eq('machineId', sid))
            .order('desc')
            .take(10)
          lastIpHash = recent.find((a) => a.ipHash !== undefined)?.ipHash
        }
        return {
          machineId: r.machineId,
          ...(r.label !== undefined ? { label: r.label } : {}),
          lastSeenAt: r.lastSeenAt,
          ...(lastIpHash !== undefined ? { lastIpHash } : {}),
          ...(r.revokedAt !== undefined ? { revokedAt: r.revokedAt } : {}),
        }
      })
    )
  },
})

/** Global lookup by machineId (globally-unique UUID). Returns enough fields for
 *  revokeDevice to act without needing to know the userId first. */
export const getByMachine = internalQuery({
  args: { machineId: v.string() },
  returns: v.union(
    v.object({
      _id: v.id('devices'),
      userId: v.id('users'),
      sid: v.optional(v.string()),
      grantRef: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (ctx, { machineId }) => {
    const row = await ctx.db
      .query('devices')
      .withIndex('byMachine', (q) => q.eq('machineId', machineId))
      .unique()
    if (row === null) return null
    return {
      _id: row._id,
      userId: row.userId,
      ...(row.sid !== undefined ? { sid: row.sid } : {}),
      ...(row.grantRef !== undefined ? { grantRef: row.grantRef } : {}),
    }
  },
})
