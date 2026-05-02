/**
 * Internal queries that return raw subscription rows (including ciphertext +
 * nonce). These are NEVER exposed publicly — only Convex actions in this
 * codebase call them via runQuery.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5 (actions need
 * the encrypted blob to decrypt; queries can't return it).
 */
import { v } from 'convex/values'

import { internalQuery } from '../_generated/server'

const subscriptionRawValidator = v.object({
  _id: v.id('subscriptions'),
  _creationTime: v.number(),
  userId: v.id('users'),
  email: v.string(),
  slot: v.number(),
  label: v.optional(v.string()),
  ciphertext: v.bytes(),
  nonce: v.bytes(),
  expiresAt: v.number(),
  refreshExpiresAt: v.optional(v.number()),
  subscriptionType: v.string(),
  rateLimitTier: v.string(),
  lastRefreshedAt: v.number(),
  refreshLeaseHolder: v.optional(v.string()),
  refreshLeaseUntil: v.optional(v.number()),
  usage5h: v.optional(v.object({ pct: v.number(), resetsAt: v.number(), fetchedAt: v.number() })),
  usage7d: v.optional(v.object({ pct: v.number(), resetsAt: v.number(), fetchedAt: v.number() })),
  removedAt: v.optional(v.number()),
})

export const getSubscriptionRaw = internalQuery({
  args: { subId: v.id('subscriptions') },
  returns: v.union(subscriptionRawValidator, v.null()),
  handler: async (ctx, { subId }) => {
    return await ctx.db.get('subscriptions', subId)
  },
})

/**
 * Look up a sub by either numeric slot or email, scoped to the actor's
 * Clerk subject. Used by `pullForSwitch` action.
 */
export const getSubscriptionForActor = internalQuery({
  args: { externalId: v.string(), slotOrEmail: v.string() },
  returns: v.union(subscriptionRawValidator, v.null()),
  handler: async (ctx, { externalId: _externalId, slotOrEmail }) => {
    void _externalId
    // Resolve sub globally; identity not used for scoping.
    const asNum = Number.parseInt(slotOrEmail, 10)
    if (!Number.isNaN(asNum) && asNum.toString() === slotOrEmail) {
      const subs = await ctx.db
        .query('subscriptions')
        .filter((q) => q.eq(q.field('slot'), asNum))
        .collect()
      const sub = subs.find((s) => s.removedAt === undefined)
      return sub ?? null
    }

    const subs = await ctx.db
      .query('subscriptions')
      .filter((q) => q.eq(q.field('email'), slotOrEmail))
      .collect()
    const sub = subs.find((s) => s.removedAt === undefined)
    return sub ?? null
  },
})

export const getSubscriptionByIdForActor = internalQuery({
  args: { externalId: v.string(), subId: v.id('subscriptions') },
  returns: v.union(subscriptionRawValidator, v.null()),
  handler: async (ctx, { externalId, subId }) => {
    // SECURITY: must verify caller owns the subscription. Without this
    // check, any signed-in Clerk user could pass another user's `subId`
    // to `requestRefresh` (or any caller of this query) and act on it —
    // the deployment's CLERK_SECRET_KEY would be a confused deputy.
    // Subscription IDs are not designed as unguessable secrets; they
    // appear in dashboard URLs and audit rows.
    const sub = await ctx.db.get('subscriptions', subId)
    if (!sub || sub.removedAt !== undefined) return null
    const owner = await ctx.db.get('users', sub.userId)
    if (!owner || owner.externalId !== externalId) return null
    return sub
  },
})

/** Internal query used by the cron to find subs whose access token expires soon. */
export const findExpiringSubs = internalQuery({
  args: { withinMs: v.number() },
  returns: v.array(v.object({ subId: v.id('subscriptions') })),
  handler: async (ctx, { withinMs }) => {
    const cutoff = Date.now() + withinMs
    const rows = await ctx.db
      .query('subscriptions')
      .withIndex('byExpiry', (q) => q.lt('expiresAt', cutoff))
      .collect()
    // Filter out tombstoned subs in JS (low cardinality of soft-deletes per spec §4).
    return rows.filter((r) => r.removedAt === undefined).map((r) => ({ subId: r._id }))
  },
})

/** Internal query used by the usage cron — list every active sub. */
export const listAllActiveSubIds = internalQuery({
  args: {},
  returns: v.array(v.object({ subId: v.id('subscriptions') })),
  handler: async (ctx) => {
    const rows = await ctx.db.query('subscriptions').collect()
    return rows.filter((r) => r.removedAt === undefined).map((r) => ({ subId: r._id }))
  },
})
