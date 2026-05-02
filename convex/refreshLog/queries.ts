/**
 * Refresh log queries — the per-sub history that powers the
 * `/dashboard/audit` route's "refresh attempts" feed.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5 + §8.
 */
import { v } from 'convex/values'

import { authenticatedQuery } from '../utils/auth'

const refreshLogRowValidator = v.object({
  _id: v.id('refreshLog'),
  _creationTime: v.number(),
  userId: v.id('users'),
  subscriptionId: v.id('subscriptions'),
  triggeredBy: v.union(v.literal('cron'), v.literal('manual'), v.literal('onUse')),
  outcome: v.union(v.literal('success'), v.literal('failure'), v.literal('reloginRequired')),
  error: v.optional(v.string()),
  at: v.number(),
})

// Any authenticated caller sees everything.
export const recentForUser = authenticatedQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(refreshLogRowValidator),
  handler: async (ctx, { limit }) => {
    return await ctx.db.query('refreshLog').order('desc').take(limit ?? 100)
  },
})

export const recentForSubscription = authenticatedQuery({
  args: { subscriptionId: v.id('subscriptions'), limit: v.optional(v.number()) },
  returns: v.array(refreshLogRowValidator),
  handler: async (ctx, { subscriptionId, limit }) => {
    return await ctx.db
      .query('refreshLog')
      .withIndex('bySubscriptionAndAt', (q) => q.eq('subscriptionId', subscriptionId))
      .order('desc')
      .take(limit ?? 100)
  },
})
