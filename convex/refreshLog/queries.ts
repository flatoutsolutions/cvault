/**
 * Refresh log queries — the per-sub history that powers the
 * `/dashboard/audit` route's "refresh attempts" feed.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5 + §8.
 *
 * SHARED-VAULT CONTRACT: per `convex/utils/users.ts:3-7`, any authenticated
 * Clerk identity that passes the email-domain allowlist is a peer reader
 * of the entire vault. These queries therefore do NOT filter rows by the
 * caller's userId or by subscription ownership — both would re-introduce
 * the per-user scoping the shared-vault design explicitly rejects.
 * Authentication + the domain gate (in `authenticatedQuery`) are the only
 * access controls; row-level data filters (e.g. by `subscriptionId`) are
 * fine because they narrow what is returned, not who may read.
 */
import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import { authenticatedQuery } from '../utils/auth'

const refreshLogRowValidator = v.object({
  _id: v.id('refreshLog'),
  _creationTime: v.number(),
  userId: v.id('users'),
  subscriptionId: v.id('subscriptions'),
  triggeredBy: v.union(v.literal('manual'), v.literal('onUse')),
  outcome: v.union(v.literal('success'), v.literal('failure'), v.literal('reloginRequired')),
  error: v.optional(v.string()),
  at: v.number(),
})

/**
 * Refresh history for `/dashboard/audit`. Cursor-paginated — `refreshLog`
 * gets one row per attempt (manual + on-use), so the table
 * accumulates rows fast and an unpaginated read would silently truncate.
 *
 * Vault-wide: returns rows from every user's refresh attempts, newest
 * first. Per the shared-vault contract (`convex/utils/users.ts:3-7`),
 * any allowlisted authenticated identity may read every row — re-adding
 * a `userId` filter here would silently re-introduce the per-user
 * scoping the shared-vault model rejects. Iterates the global `byAt`
 * index in `desc` order so pagination is index-driven rather than a
 * full-table scan.
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
    return await ctx.db.query('refreshLog').withIndex('byAt').order('desc').paginate(paginationOpts)
  },
})

/**
 * Per-subscription refresh history (drilldown view). Cursor-paginated
 * for the same reason as `recentForUser`.
 *
 * Vault-wide: returns rows for the given subscription regardless of
 * which user owns it. Per the shared-vault contract
 * (`convex/utils/users.ts:3-7`), the prior owner-vs-caller check has
 * been removed — subscription IDs are not access-control tokens, the
 * `subscriptionId` argument is a data filter (which rows), not an
 * authorization check (who may read). Authentication + the email-domain
 * allowlist (in `authenticatedQuery`) are the only gates.
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
    return await ctx.db
      .query('refreshLog')
      .withIndex('bySubscriptionAndAt', (q) => q.eq('subscriptionId', subscriptionId))
      .order('desc')
      .paginate(paginationOpts)
  },
})
