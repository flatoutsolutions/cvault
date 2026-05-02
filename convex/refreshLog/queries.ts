/**
 * Refresh log queries — the per-sub history that powers the
 * `/dashboard/audit` route's "refresh attempts" feed.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5 + §8.
 */
import { paginationOptsValidator } from 'convex/server'
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

/**
 * Refresh history for `/dashboard/audit`. Cursor-paginated — `refreshLog`
 * gets one row per attempt (manual + cron + on-use), so a busy user
 * accumulates rows fast and a `take(100)` cap silently truncates the
 * history at 100 entries.
 *
 * SECURITY: scopes to the caller via `byUserAndAt`. Without this, every
 * signed-in user received everyone's refresh attempts (sub IDs, error
 * strings, outcomes).
 */
export const recentForUser = authenticatedQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(refreshLogRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null())),
  }),
  handler: async (ctx, { paginationOpts }) => {
    const identity = getIdentity(ctx)
    const user = await ctx.db
      .query('users')
      .withIndex('byExternalId', (q) => q.eq('externalId', identity.subject))
      .unique()
    if (!user) {
      return { page: [], isDone: true, continueCursor: '' }
    }
    return await ctx.db
      .query('refreshLog')
      .withIndex('byUserAndAt', (q) => q.eq('userId', user._id))
      .order('desc')
      .paginate(paginationOpts)
  },
})

/**
 * Per-subscription refresh history (drilldown view). Cursor-paginated
 * for the same reason as `recentForUser`.
 *
 * SECURITY: verifies the caller owns the subscription before paging
 * over its history; subscription IDs are not unguessable secrets.
 */
export const recentForSubscription = authenticatedQuery({
  args: {
    subscriptionId: v.id('subscriptions'),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(refreshLogRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null())),
  }),
  handler: async (ctx, { subscriptionId, paginationOpts }) => {
    const identity = getIdentity(ctx)
    const sub = await ctx.db.get('subscriptions', subscriptionId)
    if (!sub) {
      return { page: [], isDone: true, continueCursor: '' }
    }
    const owner = await ctx.db.get('users', sub.userId)
    if (!owner || owner.externalId !== identity.subject) {
      return { page: [], isDone: true, continueCursor: '' }
    }
    return await ctx.db
      .query('refreshLog')
      .withIndex('bySubscriptionAndAt', (q) => q.eq('subscriptionId', subscriptionId))
      .order('desc')
      .paginate(paginationOpts)
  },
})
