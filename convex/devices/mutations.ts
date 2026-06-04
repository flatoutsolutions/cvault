/**
 * Internal mutations for the `devices` registry.
 *
 * These are called by the `recordLogin` / `revokeDevice` actions (built
 * in a later task). They are never exposed directly to the public API.
 *
 * Spec: CVLT-3 — CLI OAuth PKCE migration, Task 3.
 */
import { v } from 'convex/values'

import { internalMutation } from '../_generated/server'

/**
 * Create the device row on first sight; otherwise bump lastSeenAt + label
 * and clear any stale revokedAt.
 */
export const upsert = internalMutation({
  args: {
    userId: v.id('users'),
    machineId: v.string(),
    label: v.optional(v.string()),
    at: v.number(),
    grantRef: v.optional(v.string()),
    sid: v.optional(v.string()),
  },
  returns: v.id('devices'),
  handler: async (ctx, { userId, machineId, label, at, grantRef, sid }) => {
    const existing = await ctx.db
      .query('devices')
      .withIndex('byUserAndMachine', (q) => q.eq('userId', userId).eq('machineId', machineId))
      .unique()

    if (existing === null) {
      return await ctx.db.insert('devices', {
        userId,
        machineId,
        label,
        createdAt: at,
        lastSeenAt: at,
        grantRef,
        ...(sid !== undefined ? { sid } : {}),
      })
    }

    await ctx.db.patch('devices', existing._id, {
      lastSeenAt: at,
      ...(label !== undefined ? { label } : {}),
      ...(grantRef !== undefined ? { grantRef } : {}),
      ...(sid !== undefined ? { sid } : {}),
      revokedAt: undefined,
    })
    return existing._id
  },
})

/**
 * Mark a machine revoked. Caller (action) is responsible for the Clerk
 * grant revoke.
 */
export const markRevoked = internalMutation({
  args: { userId: v.id('users'), machineId: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { userId, machineId, at }) => {
    const row = await ctx.db
      .query('devices')
      .withIndex('byUserAndMachine', (q) => q.eq('userId', userId).eq('machineId', machineId))
      .unique()
    if (row !== null) await ctx.db.patch('devices', row._id, { revokedAt: at })
    return null
  },
})
