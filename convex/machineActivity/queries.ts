/**
 * Audit feed queries for the dashboard `/dashboard/audit` and
 * `/dashboard/machines` routes.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 * CVLT-3: docs/superpowers/specs/2026-06-03-cli-oauth-pkce-design.md §4–5.
 *
 * Architectural intent — shared vault. Per `convex/utils/users.ts:3-7`,
 * any authenticated identity reads any audit row. The previous per-user
 * scoping was the same root failure mode as the subscriptions queries:
 * the comment in `users.ts` advertised shared semantics but the read
 * paths still filtered by `userId`. Reads now iterate the global indexes
 * `byAt` / `byMachineAndAt`.
 *
 * CVLT-3 change: `clerkSessionId` has been replaced by the persistent
 * CLI-generated `machineId`. The sentinel / unknown-session concept is
 * dropped — every CLI write now carries a real machineId UUID.
 */
import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import { authenticatedQuery } from '../utils/auth'

const machineActivityRowValidator = v.object({
  _id: v.id('machineActivity'),
  _creationTime: v.number(),
  userId: v.id('users'),
  machineId: v.string(),
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
 * Per-machine drilldown for `/dashboard/machines/<machineId>`. Cursor
 * paginated for the same reason.
 *
 * No userId scoping — shared vault. The `byMachineAndAt` composite index
 * bounds the read to one machineId (so an unrelated machine's churn doesn't
 * cost us bandwidth) without re-introducing the per-user filter.
 */
export const recentForMachine = authenticatedQuery({
  args: {
    machineId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(machineActivityRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null())),
  }),
  handler: async (ctx, { machineId, paginationOpts }) => {
    return await ctx.db
      .query('machineActivity')
      .withIndex('byMachineAndAt', (q) => q.eq('machineId', machineId))
      .order('desc')
      .paginate(paginationOpts)
  },
})

/**
 * Distinct machines that have touched the vault — drives
 * `/dashboard/machines`.
 *
 * No userId scoping — shared vault. Reads the most-recent 1000 rows from
 * the global `byAt` index, dedupes by machineId, and returns one entry
 * per machine.
 *
 * CVLT-3: Simplified from the old clerkSessionId model. Sentinel / unknown-
 * session logic is dropped — all machines now carry a real machineId UUID.
 * The `revocable` flag is also dropped — every machine with a registered
 * device row is revocable via `revokeDevice`.
 *
 * Bound: caps at 1000 most-recent rows globally. The dashboard lists
 * machines, not raw events, so dedupe-then-truncate is sufficient even
 * across users.
 */
export const distinctSessionsForUser = authenticatedQuery({
  args: {},
  returns: v.array(
    v.object({
      machineId: v.string(),
      lastSeenAt: v.number(),
      lastIpHash: v.optional(v.string()),
      /**
       * Most-recent `machineLabel` for this machine. Optional because
       * legacy rows pre-label-feature don't carry one — the UI shows
       * "(no label)" when this is undefined.
       */
      machineLabel: v.optional(v.string()),
    })
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query('machineActivity').withIndex('byAt').order('desc').take(1000)

    const map = new Map<
      string,
      {
        machineId: string
        lastSeenAt: number
        lastIpHash?: string
        machineLabel?: string
      }
    >()

    for (const r of rows) {
      // Empty machineId shouldn't render as a clickable machine. Defense-in-depth.
      if (!r.machineId) continue
      if (map.has(r.machineId)) continue

      // Rows are .order('desc'), so the FIRST row per key is most-recent.
      const entry: {
        machineId: string
        lastSeenAt: number
        lastIpHash?: string
        machineLabel?: string
      } = {
        machineId: r.machineId,
        lastSeenAt: r.at,
      }
      if (r.ipHash !== undefined) entry.lastIpHash = r.ipHash
      if (r.machineLabel !== undefined) entry.machineLabel = r.machineLabel
      map.set(r.machineId, entry)
    }

    return Array.from(map.values())
  },
})
