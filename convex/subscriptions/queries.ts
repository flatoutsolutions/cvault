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
import { authenticatedQuery } from '../utils/auth'

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

// Any authenticated caller sees all subs.
export const listForUser = authenticatedQuery({
  args: {},
  returns: v.array(subscriptionMetaValidator),
  handler: async (ctx) => {
    const subs = await ctx.db.query('subscriptions').collect()
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
    const subs = await ctx.db
      .query('subscriptions')
      .filter((q) => q.eq(q.field('email'), email))
      .collect()
    const sub = subs.find((s) => s.removedAt === undefined)
    return sub ? toMeta(sub) : null
  },
})
