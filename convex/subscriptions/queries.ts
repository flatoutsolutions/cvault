/**
 * Subscriptions queries.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5.
 *
 * Architectural intent — shared vault. Per `convex/utils/users.ts:3-7`,
 * any authenticated Clerk identity reads/writes the same vault. These
 * read queries therefore intentionally do NOT scope by `userId`. The
 * previous per-user scoping was a bug (PR #15 hotfix): user A's friend
 * could write a row that user A could not see on the dashboard. Ciphertext
 * is still stripped on every wire shape; metadata is broadcast.
 *
 * Important security invariant: queries NEVER return ciphertext or nonce.
 * The encrypted blob lives only in the DB row and inside actions that
 * decrypt it on demand. Frontend / CLI never touch it directly.
 */
import { ConvexError, v } from 'convex/values'

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

/** Strip ciphertext + nonce + keyVersion before sending a sub over the wire. */
function toMeta(sub: Doc<'subscriptions'>) {
  const { ciphertext: _ciphertext, nonce: _nonce, keyVersion: _keyVersion, ...rest } = sub
  void _ciphertext
  void _nonce
  void _keyVersion
  return rest
}

/**
 * List every non-removed subscription in the vault, sorted by creation
 * time ascending (first-come-first-serve).
 *
 * No userId scoping by design — see `convex/utils/users.ts:3-7`. The CLI
 * uses `slot` only as a local handle; on the server, slot is no longer a
 * meaningful identifier across the shared vault. Authentication alone
 * gates access; allowlisted email enforcement is the perimeter.
 *
 * Read shape: `.collect()` over the table is fine for the size of this
 * deployment (handful of subs per vault). If the vault ever grows past
 * a few hundred rows we can switch to `.order('asc')` over a `byCreation`
 * index, but at that point the dashboard UI will have bigger problems.
 */
export const list = authenticatedQuery({
  args: {},
  returns: v.array(subscriptionMetaValidator),
  handler: async (ctx) => {
    const subs = await ctx.db.query('subscriptions').collect()
    return subs
      .filter((s) => s.removedAt === undefined)
      .sort((a, b) => a._creationTime - b._creationTime)
      .map(toMeta)
  },
})

/**
 * Legacy alias — preserved so the shipped CLI 0.1.6 binary keeps working
 * for homebrew users who haven't upgraded yet. The CLI release pipeline
 * bundles a binary; renaming the export without an alias would 404 every
 * call from already-installed copies. Drop this on the next CLI major.
 */
export const listForUser = list

export const getMetaByEmail = authenticatedQuery({
  args: { email: v.string() },
  returns: v.union(subscriptionMetaValidator, v.null()),
  handler: async (ctx, { email }) => {
    // No userId scoping — shared vault (see file-level docstring +
    // `convex/utils/users.ts`). Email is lowercased to match the storage
    // canonicalization in `mutations.ts:upsertSub`. The `byEmail` index is
    // global and exact-match.
    const subs = await ctx.db
      .query('subscriptions')
      .withIndex('byEmail', (q) => q.eq('email', email.toLowerCase()))
      .collect()
    const sub = subs.find((s) => s.removedAt === undefined)
    return sub ? toMeta(sub) : null
  },
})

// ---------------------------------------------------------------------------
// getStatus — diagnostic surface for the `cvault status` CLI command.
//
// Returns the per-sub metadata + last 3 refresh log entries + the most
// recent machineActivity row. Shared-vault reads (no userId scoping) —
// any authed allowlisted caller can resolve any sub. The CLI uses this
// to render a human-readable comparison of local vs. vault, plus an
// actionable hint when the row needs re-capture (refreshExpiresAt
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
    v.literal('login'),
    v.literal('export'),
    v.literal('import'),
    v.literal('rotate')
  ),
  clerkSessionId: v.string(),
  at: v.number(),
})

/**
 * `getStatus` accepts either an exact `subId` (preferred, unambiguous) or a
 * legacy numeric `slot` (kept for the shipped CLI 0.1.6 binary). Slot was
 * a per-user identifier under the old scoped-reads model; in the shared
 * vault it is ambiguous (multiple users may have rows at the same slot
 * number) so the slot-mode resolves with first-come-first-serve: the row
 * with the lowest `_creationTime` wins. New CLI versions should pass
 * `subId`; the alias remains until the next CLI major.
 *
 * Convex args validators must be a top-level object, not a union, so both
 * fields are optional at the schema level and runtime-checked in the
 * handler. Exactly one of `subId` / `slot` must be present.
 *
 * No userId scoping — see file-level docstring + `convex/utils/users.ts`.
 */
export const getStatus = authenticatedQuery({
  args: {
    subId: v.optional(v.id('subscriptions')),
    slot: v.optional(v.number()),
  },
  returns: v.object({
    sub: subscriptionMetaValidator,
    refreshLog: v.array(refreshLogEntryValidator),
    lastMachineActivity: v.union(lastMachineActivityValidator, v.null()),
  }),
  handler: async (ctx, args) => {
    const sub = await resolveSubFromArgs(ctx, args)

    // Last 3 refresh attempts (newest first). `bySubscriptionAndAt` is
    // the natural index for this drill-down read. Refresh log + last
    // machineActivity are scoped by `subscriptionId`, not by user — that
    // part was always correct.
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

    // Most recent machineActivity row for this sub. M4 fix: composite
    // `(subscriptionId, at)` index lookup — bounded to this sub's rows so
    // a high-churn sibling can't push out the row we want.
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

/**
 * Resolve the requested sub from `getStatus`'s args. Exactly one of
 * `subId` / `slot` must be present; passing both or neither is a caller
 * bug. Throws `NOT_FOUND` when no live row matches — same ConvexError
 * shape the CLI already handles.
 */
async function resolveSubFromArgs(
  ctx: import('convex/server').GenericQueryCtx<import('../_generated/dataModel').DataModel>,
  args: { subId?: import('../_generated/dataModel').Id<'subscriptions'>; slot?: number }
): Promise<Doc<'subscriptions'>> {
  if (args.subId !== undefined && args.slot !== undefined) {
    throw new ConvexError({
      code: 'BAD_REQUEST',
      message: 'getStatus: pass exactly one of `subId` or `slot`, not both.',
    })
  }
  if (args.subId === undefined && args.slot === undefined) {
    throw new ConvexError({
      code: 'BAD_REQUEST',
      message: 'getStatus: pass exactly one of `subId` or `slot`.',
    })
  }
  if (args.subId !== undefined) {
    const sub = await ctx.db.get('subscriptions', args.subId)
    if (!sub || sub.removedAt !== undefined) {
      throw new ConvexError({ code: 'NOT_FOUND', message: `No subscription with id ${args.subId}` })
    }
    return sub
  }

  // Legacy slot path. In shared-vault world the stored `slot` field on a
  // row is per-user and ambiguous globally (every user's first sub has
  // stored slot=1), so we ignore it for lookups. Instead the input is
  // interpreted as a FCFS rank ordinal over the active table:
  //
  //   slot=1 → oldest live sub
  //   slot=2 → second-oldest
  //   slot=N → Nth-oldest
  //
  // Matches `internalReads.getSubscriptionBySlotOrEmail`'s slot branch
  // so `cvault status N` and `cvault switch N` resolve to the same row
  // for any given N. A full-table scan is acceptable for the deployment
  // size; see `list`'s comment.
  const slot = args.slot ?? 0
  const all = await ctx.db.query('subscriptions').order('asc').collect()
  const live = all.filter((s) => s.removedAt === undefined)
  const sub = live[slot - 1]
  if (!sub) {
    throw new ConvexError({ code: 'NOT_FOUND', message: `No subscription at slot ${slot.toString()}` })
  }
  return sub
}
