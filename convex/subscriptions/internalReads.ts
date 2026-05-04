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
  handler: async (ctx, { externalId, slotOrEmail }) => {
    // SECURITY: scope the lookup to the caller's user. The previous
    // implementation matched on `slot=` / `email=` globally and would
    // return another user's row if their slot or email collided.
    // Using `byUserAndSlot` / `byUserAndEmail` indexes also keeps the
    // read bounded to one user instead of scanning the whole table.
    const user = await ctx.db
      .query('users')
      .withIndex('byExternalId', (q) => q.eq('externalId', externalId))
      .unique()
    if (!user) return null

    const asNum = Number.parseInt(slotOrEmail, 10)
    if (!Number.isNaN(asNum) && asNum.toString() === slotOrEmail) {
      const subs = await ctx.db
        .query('subscriptions')
        .withIndex('byUserAndSlot', (q) => q.eq('userId', user._id).eq('slot', asNum))
        .collect()
      const sub = subs.find((s) => s.removedAt === undefined)
      return sub ?? null
    }

    // Email branch: lowercase the lookup key to match the storage
    // canonicalization in `mutations.ts:upsertSub`. Without this,
    // `cvault switch Stefan@x.com` would NOT_FOUND when the row was
    // stored under `stefan@x.com`.
    const sub = await ctx.db
      .query('subscriptions')
      .withIndex('byUserAndEmail', (q) => q.eq('userId', user._id).eq('email', slotOrEmail.toLowerCase()))
      .unique()
    return sub && sub.removedAt === undefined ? sub : null
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

/**
 * How far back the cron looks for already-expired tokens whose refresh
 * tokens may still be valid. Anthropic refresh tokens are valid ~30 days
 * (per docs/research/anthropic-oauth-refresh.md); a row whose access
 * token expired before this lookback floor is unrecoverable, and
 * including it in the scan only burns index bandwidth.
 *
 * The motivating perf bug (Track B item 10): the prior implementation
 * scanned `byExpiry` from the lowest-historical `expiresAt` up to the
 * cutoff with NO lower bound, which dragged in long-tombstoned rows.
 * The `removedAt === undefined` JS filter still excluded them from the
 * result, but the read amplification was unbounded as the table grew.
 */
const RECOVERABLE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A sub is "RT dead" once `markReloginRequired` clamps `refreshExpiresAt`
 * to `Date.now()` after Anthropic answered `invalid_grant`. Dead subs MUST
 * be excluded from cron scans — otherwise every tick re-drives Anthropic
 * (burns an API call), logs a fresh `reloginRequired` row (spam), and
 * gives the user nothing they didn't already know. Recovery requires the
 * user to `cvault add` again on a machine that holds a fresh blob; until
 * that happens, the cron has no productive work to do.
 *
 * `refreshExpiresAt === undefined` is treated as "alive" because legacy /
 * never-refreshed rows lack the field — excluding them would silently
 * drop every sub created before RT-tracking landed.
 */
function isReloginRequired(row: { refreshExpiresAt?: number }, now: number): boolean {
  return row.refreshExpiresAt !== undefined && row.refreshExpiresAt <= now
}

/** Internal query used by the cron to find subs whose access token expires soon. */
export const findExpiringSubs = internalQuery({
  args: { withinMs: v.number() },
  returns: v.array(v.object({ subId: v.id('subscriptions') })),
  handler: async (ctx, { withinMs }) => {
    const now = Date.now()
    const cutoff = now + withinMs
    const floor = now - RECOVERABLE_LOOKBACK_MS
    const rows = await ctx.db
      .query('subscriptions')
      .withIndex('byExpiry', (q) => q.gt('expiresAt', floor).lt('expiresAt', cutoff))
      .collect()
    // Filter out tombstoned subs in JS (low cardinality of soft-deletes per spec §4).
    // Also exclude RT-dead subs — see `isReloginRequired` above.
    return rows.filter((r) => r.removedAt === undefined && !isReloginRequired(r, now)).map((r) => ({ subId: r._id }))
  },
})

/** Internal query used by the usage cron — list every active sub. */
export const listAllActiveSubIds = internalQuery({
  args: {},
  returns: v.array(v.object({ subId: v.id('subscriptions') })),
  handler: async (ctx) => {
    const now = Date.now()
    const rows = await ctx.db.query('subscriptions').collect()
    // Polling usage with a dead access token is wasted work — the next
    // refresh cycle won't be able to recover it without user re-capture.
    return rows.filter((r) => r.removedAt === undefined && !isReloginRequired(r, now)).map((r) => ({ subId: r._id }))
  },
})

/**
 * Internal query returning rows whose keyVersion does not match the supplied
 * targetVersion. Used by `rotateAllSubscriptions` to find work to do.
 *
 * Returns the full row (ciphertext + nonce + keyVersion) so the action
 * can decrypt without a second read.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §5.
 */
export const listSubsForRotation = internalQuery({
  args: { userId: v.id('users'), targetVersion: v.string() },
  returns: v.array(subscriptionRawValidator),
  handler: async (ctx, { userId, targetVersion }) => {
    const rows = await ctx.db
      .query('subscriptions')
      .withIndex('byUserAndSlot', (q) => q.eq('userId', userId))
      .collect()
    return rows.filter((r) => r.removedAt === undefined && (r.keyVersion ?? 'v1') !== targetVersion)
  },
})

/**
 * Internal query returning every active sub for a user. Used by the
 * backup export action.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
 */
export const listSubsForUserId = internalQuery({
  args: { userId: v.id('users') },
  returns: v.array(subscriptionRawValidator),
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query('subscriptions')
      .withIndex('byUserAndSlot', (q) => q.eq('userId', userId))
      .collect()
    return rows.filter((r) => r.removedAt === undefined)
  },
})
