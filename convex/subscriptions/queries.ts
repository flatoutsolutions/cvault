/**
 * Subscriptions queries.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5.
 *
 * Important security invariant: queries NEVER return ciphertext or nonce.
 * The encrypted blob lives only in the DB row and inside actions that
 * decrypt it on demand. Frontend / CLI never touch it directly.
 */
import { ConvexError, v } from 'convex/values'

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
    //
    // Email is lowercased to match the storage convention set in
    // `mutations.ts:upsertSub`. The byUserAndEmail index is exact-string,
    // so without this the lookup would miss rows persisted under a
    // different case than the caller passed in.
    const userId = await callerUserId(ctx)
    if (userId === null) return null
    const subs = await ctx.db
      .query('subscriptions')
      .withIndex('byUserAndEmail', (q) => q.eq('userId', userId).eq('email', email.toLowerCase()))
      .collect()
    const sub = subs.find((s) => s.removedAt === undefined)
    return sub ? toMeta(sub) : null
  },
})

// ---------------------------------------------------------------------------
// getStatus — diagnostic surface for the new `cvault status` CLI command.
//
// Returns the per-sub metadata + last 3 refresh log entries + the most
// recent machineActivity row, all scoped to the caller. The CLI uses
// this to render a human-readable comparison of local vs. vault, plus
// an actionable hint when the row needs re-capture (refreshExpiresAt
// clamped).
//
// Read-only by design: this is the surface the CLI hits before deciding
// whether to call `refreshSub` (which mutates).
// ---------------------------------------------------------------------------

const refreshLogEntryValidator = v.object({
  outcome: v.union(v.literal('success'), v.literal('failure'), v.literal('reloginRequired')),
  triggeredBy: v.union(v.literal('cron'), v.literal('manual'), v.literal('onUse')),
  at: v.number(),
  error: v.optional(v.string()),
})

const lastMachineActivityValidator = v.object({
  action: v.union(
    v.literal('switch'),
    v.literal('add'),
    v.literal('pull'),
    v.literal('remove'),
    v.literal('refresh'),
    v.literal('rename'),
    v.literal('login')
  ),
  clerkSessionId: v.string(),
  at: v.number(),
})

export const getStatus = authenticatedQuery({
  args: { slot: v.number() },
  returns: v.object({
    sub: subscriptionMetaValidator,
    refreshLog: v.array(refreshLogEntryValidator),
    lastMachineActivity: v.union(lastMachineActivityValidator, v.null()),
  }),
  handler: async (ctx, { slot }) => {
    const userId = await callerUserId(ctx)
    if (userId === null) {
      // The Clerk webhook hasn't fired yet — treat as "no subs" by
      // throwing the same NOT_FOUND the slot-not-owned branch throws so
      // the CLI gets one shape to handle.
      throw new ConvexError({ code: 'NOT_FOUND', message: `No subscription at slot ${slot.toString()}` })
    }
    const matches = await ctx.db
      .query('subscriptions')
      .withIndex('byUserAndSlot', (q) => q.eq('userId', userId).eq('slot', slot))
      .collect()
    const sub = matches.find((s) => s.removedAt === undefined)
    if (!sub) {
      throw new ConvexError({ code: 'NOT_FOUND', message: `No subscription at slot ${slot.toString()}` })
    }

    // Last 3 refresh attempts (newest first). `bySubscriptionAndAt` is
    // the natural index for this drill-down read.
    const recentLogs = await ctx.db
      .query('refreshLog')
      .withIndex('bySubscriptionAndAt', (q) => q.eq('subscriptionId', sub._id))
      .order('desc')
      .take(3)
    const refreshLog = recentLogs.map((row) => {
      const base: { outcome: typeof row.outcome; triggeredBy: typeof row.triggeredBy; at: number; error?: string } = {
        outcome: row.outcome,
        triggeredBy: row.triggeredBy,
        at: row.at,
      }
      if (row.error !== undefined) base.error = row.error
      return base
    })

    // Most recent machineActivity row for this sub (any session, any
    // action). Used by the CLI to print "Last activity: switch on
    // sess_xyz, 3h ago" alongside the relogin hint when needed.
    //
    // M4: use the (subscriptionId, at) composite index added to
    // `machineActivity` schema. Previously the query took the user's
    // 50 most-recent rows across ALL subs and filtered by subId, which
    // silently lost a low-churn sub's activity behind a high-churn
    // sibling. The index lookup is bounded to this sub's rows and
    // returns the most recent one in a single read.
    const subActivity = await ctx.db
      .query('machineActivity')
      .withIndex('bySubscriptionAndAt', (q) => q.eq('subscriptionId', sub._id))
      .order('desc')
      .first()
    const lastMachineActivity = subActivity
      ? {
          action: subActivity.action,
          clerkSessionId: subActivity.clerkSessionId,
          at: subActivity.at,
        }
      : null

    return {
      sub: toMeta(sub),
      refreshLog,
      lastMachineActivity,
    }
  },
})
