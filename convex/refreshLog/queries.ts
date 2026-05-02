/**
 * Refresh log queries — the per-sub history that powers the
 * `/dashboard/audit` route's "refresh attempts" feed.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5 + §8.
 */
import { v } from 'convex/values'

import { authenticatedQuery, getIdentity } from '../utils/auth'

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

export const recentForUser = authenticatedQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(refreshLogRowValidator),
  handler: async (ctx, { limit }) => {
    // SECURITY: scope to the caller. The previous implementation paged
    // every user's refresh attempts back to whoever asked — direct
    // metadata leak (sub IDs, error messages, refresh outcomes). Resolve
    // the caller's `users._id` and use the `byUserAndAt` index to keep
    // the query bounded.
    const identity = getIdentity(ctx)
    const user = await ctx.db
      .query('users')
      .withIndex('byExternalId', (q) => q.eq('externalId', identity.subject))
      .unique()
    if (!user) return []
    return await ctx.db
      .query('refreshLog')
      .withIndex('byUserAndAt', (q) => q.eq('userId', user._id))
      .order('desc')
      .take(limit ?? 100)
  },
})

export const recentForSubscription = authenticatedQuery({
  args: { subscriptionId: v.id('subscriptions'), limit: v.optional(v.number()) },
  returns: v.array(refreshLogRowValidator),
  handler: async (ctx, { subscriptionId, limit }) => {
    // SECURITY: verify the caller owns the subscription before
    // returning its refresh history.
    const identity = getIdentity(ctx)
    const sub = await ctx.db.get('subscriptions', subscriptionId)
    if (!sub) return []
    const owner = await ctx.db.get('users', sub.userId)
    if (!owner || owner.externalId !== identity.subject) return []
    return await ctx.db
      .query('refreshLog')
      .withIndex('bySubscriptionAndAt', (q) => q.eq('subscriptionId', subscriptionId))
      .order('desc')
      .take(limit ?? 100)
  },
})
