/**
 * Audit feed queries for the dashboard `/dashboard/audit` and
 * `/dashboard/machines` routes.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Architectural intent — shared vault. Per `convex/utils/users.ts:3-7`,
 * any authenticated identity reads any audit row. The previous per-user
 * scoping was the same root failure mode as the subscriptions queries:
 * the comment in `users.ts` advertised shared semantics but the read
 * paths still filtered by `userId`. Reads now iterate the global indexes
 * `byAt` / `bySessionAndAt`.
 */
import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import { authenticatedQuery } from '../utils/auth'
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
    v.literal('import'),
    v.literal('rotate')
  ),
  subscriptionId: v.optional(v.id('subscriptions')),
  at: v.number(),
  ipHash: v.optional(v.string()),
  machineLabel: v.optional(v.string()),
})

/**
 * Audit feed for `/dashboard/audit`. Cursor-paginated so the page can
 * scroll the full history without paying a `.collect()` over an
 * append-only table that grows on every action (one row per add /
 * switch / refresh / pull / remove / login).
 *
 * No userId scoping — shared vault (see file-level docstring +
 * `convex/utils/users.ts`). The query iterates the global `byAt` index
 * so the feed shows every machine's activity to every authed reader.
 * The legacy name (`recentForUser`) is preserved for frontend / shipped
 * client compatibility but the contract is now "recent across the
 * vault".
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
    return await ctx.db.query('machineActivity').withIndex('byAt').order('desc').paginate(paginationOpts)
  },
})

/**
 * Per-machine drilldown for `/dashboard/machines/<sessionId>`. Cursor
 * paginated for the same reason.
 *
 * No userId scoping — shared vault. The `bySessionAndAt` composite index
 * bounds the read to one sid (so an unrelated machine's churn doesn't
 * cost us bandwidth) without re-introducing the per-user filter.
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
    return await ctx.db
      .query('machineActivity')
      .withIndex('bySessionAndAt', (q) => q.eq('clerkSessionId', clerkSessionId))
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
 * Distinct machines that have touched the vault — drives
 * `/dashboard/machines`.
 *
 * No userId scoping — shared vault. Reads the most-recent 1000 rows from
 * the global `byAt` index, dedupes, and returns one entry per machine.
 *
 * Grouping rules (unchanged):
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
 * Bound: caps at 1000 most-recent rows globally. The dashboard lists
 * machines, not raw events, so dedupe-then-truncate is sufficient even
 * across users.
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
    const rows = await ctx.db.query('machineActivity').withIndex('byAt').order('desc').take(1000)

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
