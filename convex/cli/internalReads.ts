/**
 * Internal queries that return raw subscription rows for the cli/sync
 * bundle. Note: these are NEVER exposed publicly; only the
 * `cli/syncAction.ts` Node action calls them via runQuery.
 */
import { v } from 'convex/values'

import { internalQuery } from '../_generated/server'

const rawSubValidator = v.object({
  _id: v.id('subscriptions'),
  _creationTime: v.number(),
  userId: v.id('users'),
  email: v.string(),
  slot: v.number(),
  label: v.optional(v.string()),
  ciphertext: v.bytes(),
  nonce: v.bytes(),
  keyVersion: v.optional(v.string()),
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

export const listSubsRawForUser = internalQuery({
  args: { externalId: v.string() },
  returns: v.array(rawSubValidator),
  handler: async (ctx, { externalId: _externalId }) => {
    void _externalId
    const subs = await ctx.db.query('subscriptions').collect()
    return subs.filter((s) => s.removedAt === undefined)
  },
})
