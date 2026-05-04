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
import { isUnknownSession } from '../utils/identity'

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
    v.literal('login'),
    v.literal('export'),
    v.literal('import')
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
 *
 * Sentinel guard: a deeplink to `/dashboard/machines/unknown-session`
 * would otherwise mix every cron-driven write across every machine into
 * one page. The dashboard never produces that link (the Machines view
 * disables drilldown for non-revocable rows) but defending here keeps
 * the contract explicit for direct API callers.
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
    if (isUnknownSession(clerkSessionId)) {
      return { page: [], isDone: true, continueCursor: '' }
    }
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
 * Composite key delimiter for the `(sentinel, machineLabel)` group in
 * {@link distinctSessionsForUser}. ASCII Unit Separator (U+001F) — the
 * exact glyph the standard reserved for this purpose. Cannot occur in a
 * Clerk session id (alphanumeric + underscore) or in a user-supplied
 * `--label` (no shell would let a literal U+001F land in argv without
 * deliberate encoding effort), so collisions like `("sess_a", "b c")`
 * vs `("sess_a b", "c")` that a space delimiter would produce cannot
 * happen. The dashboard's `rowKey` in `machines.lazy.tsx` MUST use the
 * same delimiter — otherwise React's per-row state (pending/error)
 * would key off a different row identity than the query exposes,
 * causing spinners and inline errors to bleed across rows.
 *
 * Constructed via `String.fromCharCode` so the source file stays pure
 * ASCII — a literal U+001F embedded in the string would flip git's
 * binary-detection heuristic and force `git diff` into binary mode.
 */
export const SENTINEL_GROUP_DELIMITER = String.fromCharCode(0x1f)

/**
 * Distinct machines the current user has touched the vault from — drives
 * `/dashboard/machines`.
 *
 * SECURITY: scopes to the caller (was reading the global table).
 *
 * Grouping rules:
 *
 *  - Real Clerk session ids: collapse on sid alone — one row per sid.
 *    Rows are read `.order('desc')` by `at`, so the FIRST row per sid
 *    is the most-recent one and its `machineLabel` is what surfaces.
 *    A relabel-in-place via `cvault login --label new` therefore
 *    replaces the prior label rather than leaving a ghost row.
 *
 *  - The unknown-session sentinel (see `utils/identity.ts`): split per
 *    `(sentinel, machineLabel)`. Cron, server-context writes, and
 *    pre-fix CLIs all write the sentinel; collapsing them into one row
 *    would lump every machine's server-side activity into a single
 *    misleading entry. Splitting by label preserves at least the
 *    per-machine identity even though the sid is missing.
 *
 * Revocability: rows whose `clerkSessionId` matches the sentinel cannot
 * be revoked (no live Clerk session to call BAPI against). The query
 * surfaces a `revocable` flag so the UI can render Revoke disabled with
 * an explanatory tooltip rather than hiding the row outright.
 *
 * Bound: caps at 1000 most-recent rows for *this user*. The dashboard
 * lists machines, not raw events, so dedupe-then-truncate is sufficient.
 */
export const distinctSessionsForUser = authenticatedQuery({
  args: {},
  returns: v.array(
    v.object({
      clerkSessionId: v.string(),
      lastSeenAt: v.number(),
      lastIpHash: v.optional(v.string()),
      /**
       * Most-recent `machineLabel` for this group. Optional because
       * legacy rows pre-label-feature don't carry one — the UI shows
       * "(no label)" / "Server-side activity" when this is undefined.
       */
      machineLabel: v.optional(v.string()),
      /**
       * Whether the row maps to a revocable Clerk session. False for
       * the sentinel (cron / server context / pre-fix CLI). UI disables
       * Revoke and explains why.
       */
      revocable: v.boolean(),
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
      {
        clerkSessionId: string
        lastSeenAt: number
        lastIpHash?: string
        machineLabel?: string
        revocable: boolean
      }
    >()
    for (const r of rows) {
      // Empty sid is structurally identical to "no session" and
      // shouldn't render as a clickable machine. Defense-in-depth: no
      // caller writes empty strings today, but a future bug shouldn't
      // leak a phantom row.
      if (!r.clerkSessionId) continue

      // Real sids: one row per sid (most-recent label wins because rows
      // are .order('desc') by at). Sentinel sids: one row per label, so
      // N machines with no real Clerk session each get a distinguishable
      // entry instead of collapsing into one misleading row.
      const isSentinel = isUnknownSession(r.clerkSessionId)
      const key = isSentinel
        ? `${r.clerkSessionId}${SENTINEL_GROUP_DELIMITER}${r.machineLabel ?? ''}`
        : r.clerkSessionId
      if (map.has(key)) continue

      // Rows are .order('desc'), so the FIRST row per key is most-recent.
      const entry: {
        clerkSessionId: string
        lastSeenAt: number
        lastIpHash?: string
        machineLabel?: string
        revocable: boolean
      } = {
        clerkSessionId: r.clerkSessionId,
        lastSeenAt: r.at,
        revocable: !isSentinel,
      }
      if (r.ipHash !== undefined) entry.lastIpHash = r.ipHash
      if (r.machineLabel !== undefined) entry.machineLabel = r.machineLabel
      map.set(key, entry)
    }
    return Array.from(map.values())
  },
})
