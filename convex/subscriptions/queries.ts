/**
 * Subscriptions queries.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5.
 *
 * Important security invariant: queries NEVER return ciphertext or nonce.
 * The encrypted blob lives only in the DB row and inside actions that
 * decrypt it on demand. Frontend / CLI never touch it directly.
 */
import { v } from 'convex/values'

import { type Doc } from '../_generated/dataModel'
import { authenticatedQuery, getIdentity } from '../utils/auth'

const subscriptionMetaValidator = v.object({
  _id: v.id('subscriptions'),
  _creationTime: v.number(),
  userId: v.id('users'),
  email: v.string(),
  slot: v.number(),
  label: v.optional(v.string()),
  expiresAt: v.number(),
  refreshExpiresAt: v.optional(v.number()),
  subscriptionType: v.string(),
  rateLimitTier: v.string(),
  lastRefreshedAt: v.number(),
  refreshLeaseHolder: v.optional(v.string()),
  refreshLeaseUntil: v.optional(v.number()),
  usage5h: v.optional(
    v.object({
      pct: v.number(),
      resetsAt: v.number(),
      fetchedAt: v.number(),
    })
  ),
  usage7d: v.optional(
    v.object({
      pct: v.number(),
      resetsAt: v.number(),
      fetchedAt: v.number(),
    })
  ),
  removedAt: v.optional(v.number()),
})

/** Strip ciphertext + nonce before sending a sub over the wire. */
function toMeta(sub: Doc<'subscriptions'>) {
  const { ciphertext: _ciphertext, nonce: _nonce, ...rest } = sub
  void _ciphertext
  void _nonce
  return rest
}

/**
 * Resolve the caller's `users` row id from their Clerk identity. Returns
 * `null` when no row exists yet — typically because the Clerk webhook
 * has not yet fired. Callers treat that the same as "no subscriptions"
 * to avoid leaking the anomaly.
 */
async function callerUserId(
  ctx: import('convex/server').GenericQueryCtx<import('../_generated/dataModel').DataModel>
): Promise<import('../_generated/dataModel').Id<'users'> | null> {
  const identity = getIdentity(ctx)
  const user = await ctx.db
    .query('users')
    .withIndex('byExternalId', (q) => q.eq('externalId', identity.subject))
    .unique()
  return user?._id ?? null
}

export const listForUser = authenticatedQuery({
  args: {},
  returns: v.array(subscriptionMetaValidator),
  handler: async (ctx) => {
    // SECURITY: scope the query to the authenticated caller. Without this
    // filter, every signed-in user would receive everyone else's sub
    // metadata (including emails, slot numbers, expiry timestamps, and
    // org names). The ciphertext is still stripped by `toMeta`, but
    // metadata leakage alone is a critical privacy bug.
    const userId = await callerUserId(ctx)
    if (userId === null) return []
    const subs = await ctx.db
      .query('subscriptions')
      .withIndex('byUserAndSlot', (q) => q.eq('userId', userId))
      .collect()
    return subs
      .filter((s) => s.removedAt === undefined)
      .sort((a, b) => a.slot - b.slot)
      .map(toMeta)
  },
})

export const getMetaByEmail = authenticatedQuery({
  args: { email: v.string() },
  returns: v.union(subscriptionMetaValidator, v.null()),
  handler: async (ctx, { email }) => {
    // SECURITY: scope to the caller. A globally-keyed lookup would let
    // any signed-in user enumerate other users' subs by email.
    const userId = await callerUserId(ctx)
    if (userId === null) return null
    const subs = await ctx.db
      .query('subscriptions')
      .withIndex('byUserAndEmail', (q) => q.eq('userId', userId).eq('email', email))
      .collect()
    const sub = subs.find((s) => s.removedAt === undefined)
    return sub ? toMeta(sub) : null
  },
})
