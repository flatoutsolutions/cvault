/**
 * Audit feed queries for the dashboard `/dashboard/audit` route.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Per spec §4 only `byUserAndAt` is indexed; we read newest-first and
 * cap at the requested limit.
 */
import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import { authenticatedQuery, getIdentity } from '../utils/auth'

const machineActivityRowValidator = v.object({
  _id: v.id('machineActivity'),
  _creationTime: v.number(),
  userId: v.id('users'),
  clerkSessionId: v.string(),
  action: v.union(
    v.literal('switch'),
    v.literal('add'),
    v.literal('pull'),
    v.literal('remove'),
    v.literal('refresh'),
    v.literal('rename'),
    v.literal('login')
  ),
  subscriptionId: v.optional(v.id('subscriptions')),
  at: v.number(),
  ipHash: v.optional(v.string()),
  machineLabel: v.optional(v.string()),
})

/**
 * Resolve the caller's `users._id`. Returns `null` if the Clerk webhook
 * hasn't fired yet — callers treat that as "no rows" to avoid leaking
 * the anomaly.
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

/**
 * Audit feed for `/dashboard/audit`. Cursor-paginated so the page can
 * scroll the full history without paying a `.collect()` over an
 * append-only table that grows on every action (one row per add /
 * switch / refresh / pull / remove / login).
 *
 * SECURITY: scopes to the caller. Pre-fix, every signed-in user
 * received everyone's audit history.
 */
export const recentForUser = authenticatedQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(machineActivityRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null())),
  }),
  handler: async (ctx, { paginationOpts }) => {
    const userId = await callerUserId(ctx)
    if (userId === null) {
      return { page: [], isDone: true, continueCursor: '' }
    }
    return await ctx.db
      .query('machineActivity')
      .withIndex('byUserAndAt', (q) => q.eq('userId', userId))
      .order('desc')
      .paginate(paginationOpts)
  },
})

/**
 * Per-machine drilldown for `/dashboard/machines/<sessionId>`. Cursor
 * paginated for the same reason.
 *
 * SECURITY: uses the `byUserAndSessionAndAt` composite index so a
 * malicious caller can't read another user's audit rows by guessing a
 * session id.
 */
export const recentForSession = authenticatedQuery({
  args: {
    clerkSessionId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(machineActivityRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null())),
  }),
  handler: async (ctx, { clerkSessionId, paginationOpts }) => {
    const userId = await callerUserId(ctx)
    if (userId === null) {
      return { page: [], isDone: true, continueCursor: '' }
    }
    return await ctx.db
      .query('machineActivity')
      .withIndex('byUserAndSessionAndAt', (q) => q.eq('userId', userId).eq('clerkSessionId', clerkSessionId))
      .order('desc')
      .paginate(paginationOpts)
  },
})

/**
 * Distinct Clerk session ids the current user has touched the vault from
 * — drives `/dashboard/machines`.
 *
 * SECURITY: scopes to the caller (was reading the global table).
 *
 * Bound: caps at 1000 most-recent rows for *this user*. The dashboard
 * lists machines, not raw events, so dedupe-then-truncate is sufficient.
 * If a power user ever exceeds 1000 rows on a single machine before
 * their next sync, the second machine will be missing — that's the
 * tradeoff for a non-paginated query.
 */
export const distinctSessionsForUser = authenticatedQuery({
  args: {},
  returns: v.array(
    v.object({
      clerkSessionId: v.string(),
      lastSeenAt: v.number(),
      lastIpHash: v.optional(v.string()),
      /**
       * Most-recent `machineLabel` for this session. The dashboard's
       * "Machines" section renders this as the primary identifier;
       * `clerkSessionId` is kept internal for the revoke flow. Optional
       * because legacy rows pre-feature don't carry one — the UI shows
       * "(no label)" when this is undefined.
       */
      machineLabel: v.optional(v.string()),
    })
  ),
  handler: async (ctx) => {
    const userId = await callerUserId(ctx)
    if (userId === null) return []
    const rows = await ctx.db
      .query('machineActivity')
      .withIndex('byUserAndAt', (q) => q.eq('userId', userId))
      .order('desc')
      .take(1000)

    const map = new Map<
      string,
      { clerkSessionId: string; lastSeenAt: number; lastIpHash?: string; machineLabel?: string }
    >()
    for (const r of rows) {
      if (map.has(r.clerkSessionId)) continue
      // Rows are .order('desc'), so the FIRST row we see for each
      // sessionId is its most-recent — that's where the freshest label
      // lives. Renames via `cvault login --label` flow through here on
      // the next refresh because the new login row outranks the old.
      const entry: { clerkSessionId: string; lastSeenAt: number; lastIpHash?: string; machineLabel?: string } = {
        clerkSessionId: r.clerkSessionId,
        lastSeenAt: r.at,
      }
      if (r.ipHash !== undefined) entry.lastIpHash = r.ipHash
      if (r.machineLabel !== undefined) entry.machineLabel = r.machineLabel
      map.set(r.clerkSessionId, entry)
    }
    return Array.from(map.values())
  },
})
