/**
 * Machine activity — audit trail of CLI operations per Clerk session.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §4.
 *
 * SECURITY: `ipHash` is a SHA-256 prefix (first 8 hex chars). Raw IPs
 * are never stored.
 */
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const machineActivitySchema = defineTable({
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
    /**
     * Bulk-credential operations (no `subscriptionId` — they affect
     * every sub the caller owns). Spec:
     * docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
     * A6 from the 2026-05-04 review: backup export / import is the
     * highest-impact action in the system; it MUST leave an audit row.
     * `rotate` covers `triggerKeyRotation` (re-wraps every sub).
     */
    v.literal('export'),
    v.literal('import'),
    v.literal('rotate')
  ),
  subscriptionId: v.optional(v.id('subscriptions')),
  at: v.number(),
  ipHash: v.optional(v.string()),
  /**
   * Human-readable identifier for the originating machine. The CLI
   * defaults this to `os.hostname()` at session creation; the user
   * can override via `cvault login --label`. Stored on every row so the
   * dashboard's per-session aggregation picks up the most-recent label
   * for each clerkSessionId without a separate join. Optional because:
   *  (a) legacy rows pre-feature don't have it, and
   *  (b) browser callers (dashboard "Force Refresh") don't have a
   *      hostname — they pass `undefined`.
   */
  machineLabel: v.optional(v.string()),
})
  .index('byUserAndAt', ['userId', 'at'])
  .index('byUserAndSessionAndAt', ['userId', 'clerkSessionId', 'at'])
  // M4: composite (subscriptionId, at) index for the per-sub
  // most-recent-activity lookup in `subscriptions.queries.getStatus`.
  // Without this, the query had to take the user's 50 most-recent rows
  // across ALL subs and then filter — which silently lost sub B's
  // activity when sub A was high-churn. Mirrors `refreshLog`'s
  // `bySubscriptionAndAt` pattern.
  .index('bySubscriptionAndAt', ['subscriptionId', 'at'])
  // Shared-vault read paths. `byAt` powers `recentForUser` /
  // `distinctSessionsForUser`; `bySessionAndAt` powers `recentForSession`.
  // Per `convex/utils/users.ts:3-7` audit reads are NOT scoped by user;
  // these indexes let the queries iterate the table efficiently without
  // a per-user prefix. The legacy `byUserAndAt` / `byUserAndSessionAndAt`
  // indexes are retained because they may be used by other paths and
  // index removal would require a migration commit.
  .index('byAt', ['at'])
  .index('bySessionAndAt', ['clerkSessionId', 'at'])
