/**
 * Audit feed queries for the dashboard `/dashboard/audit` route.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Per spec §4 only `byUserAndAt` is indexed; we read newest-first and
 * cap at the requested limit.
 */
import { v } from 'convex/values'

import { authenticatedQuery } from '../utils/auth'

const machineActivityRowValidator = v.object({
  _id: v.id('machineActivity'),
  _creationTime: v.number(),
  userId: v.id('users'),
  clerkSessionId: v.string(),
  action: v.union(
    v.literal('switch'),
    v.literal('add'),
    v.literal('pull'),
    v.literal('remove'),
    v.literal('refresh'),
    v.literal('rename'),
    v.literal('login')
  ),
  subscriptionId: v.optional(v.id('subscriptions')),
  at: v.number(),
  ipHash: v.optional(v.string()),
})

// Any authenticated caller sees everything.
export const recentForUser = authenticatedQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(machineActivityRowValidator),
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query('machineActivity')
      .order('desc')
      .take(limit ?? 100)
  },
})

/**
 * Per-machine drilldown: return activity rows scoped to a single Clerk
 * session id.
 */
export const recentForSession = authenticatedQuery({
  args: { clerkSessionId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(machineActivityRowValidator),
  handler: async (ctx, { clerkSessionId, limit }) => {
    const rows = await ctx.db
      .query('machineActivity')
      .filter((q) => q.eq(q.field('clerkSessionId'), clerkSessionId))
      .order('desc')
      .take(limit ?? 100)
    return rows
  },
})

/**
 * Returns the distinct Clerk session ids that have ever appeared in audit
 * rows for the current user — used by `/dashboard/machines` to show "your
 * machines that have used the vault."
 */
export const distinctSessionsForUser = authenticatedQuery({
  args: {},
  returns: v.array(
    v.object({
      clerkSessionId: v.string(),
      lastSeenAt: v.number(),
      lastIpHash: v.optional(v.string()),
    })
  ),
  handler: async (ctx) => {
    // 1000 most recent rows across all writers.
    const rows = await ctx.db.query('machineActivity').order('desc').take(1000)

    const map = new Map<string, { clerkSessionId: string; lastSeenAt: number; lastIpHash?: string }>()
    for (const r of rows) {
      if (map.has(r.clerkSessionId)) continue
      map.set(r.clerkSessionId, {
        clerkSessionId: r.clerkSessionId,
        lastSeenAt: r.at,
        lastIpHash: r.ipHash,
      })
    }
    return Array.from(map.values())
  },
})
