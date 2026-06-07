/**
 * One-shot reset of stale data accumulated across the auth + vault rewrites
 * (OAuth-PKCE, machine-id re-key, in-place token refresh). The credential
 * blobs, audit trail, and operational records changed shape, so old rows are
 * inconsistent with the current schema/encryption and must be cleared.
 *
 * KEPT (never clearable here — deliberately absent from `CLEARABLE_TABLES`):
 *   - `users`               (user data)
 *   - `allowedEmailDomains` (login allowlist — empty allowlist denies ALL logins)
 *   - `allowedEmails`       (login allowlist)
 *
 * CLEARED:
 *   subscriptions, machineActivity, refreshLog, keyRotationJobs, devices,
 *   revokedSessions, rateLimit, revokedUsers
 *
 * The restricted `table` union is the safety mechanism: a typo or a future
 * edit cannot point this at `users` or an allowlist — those names are not in
 * the validator, so the call is rejected before any delete.
 *
 * Run against a deployment with the deploy key set. One command drains
 * everything:
 *   CONVEX_DEPLOY_KEY=<key> npx convex run migrations/resetStaleData:resetStaleData '{}'
 *
 * Or drain a single table (re-run until `done: true`):
 *   CONVEX_DEPLOY_KEY=<key> npx convex run migrations/resetStaleData:clearTable '{"table":"subscriptions"}'
 */
import { v } from 'convex/values'

import { internal } from '../_generated/api'
import { internalAction, internalMutation } from '../_generated/server'

/** Rows deleted per `clearTable` call — well under Convex's per-mutation write cap. */
const BATCH = 500

/**
 * The ONLY tables this migration may touch. `users` and the allowlists are
 * intentionally excluded so they can never be cleared through this path.
 */
const clearableTable = v.union(
  v.literal('subscriptions'),
  v.literal('machineActivity'),
  v.literal('refreshLog'),
  v.literal('keyRotationJobs'),
  v.literal('devices'),
  v.literal('revokedSessions'),
  v.literal('rateLimit'),
  v.literal('revokedUsers')
)

const CLEARABLE_TABLES = [
  'subscriptions',
  'machineActivity',
  'refreshLog',
  'keyRotationJobs',
  'devices',
  'revokedSessions',
  'rateLimit',
  'revokedUsers',
] as const

/**
 * Delete up to `BATCH` rows from one clearable table. Drain-delete: each call
 * takes the next slice (deleted rows no longer appear), so re-running until
 * `done: true` empties the table. Idempotent — a call on an empty table
 * deletes 0 and returns `done: true`.
 */
export const clearTable = internalMutation({
  args: { table: clearableTable },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, { table }) => {
    const rows = await ctx.db.query(table).take(BATCH)
    for (const row of rows) {
      await ctx.db.delete(table, row._id)
    }
    return { deleted: rows.length, done: rows.length < BATCH }
  },
})

/**
 * Orchestrator: drain every clearable table to empty in one invocation.
 * Loops `clearTable` per table until done, returns the per-table delete count.
 */
export const resetStaleData = internalAction({
  args: {},
  returns: v.record(v.string(), v.number()),
  handler: async (ctx): Promise<Record<string, number>> => {
    const summary: Record<string, number> = {}
    for (const table of CLEARABLE_TABLES) {
      let total = 0
      let done = false
      while (!done) {
        const res = await ctx.runMutation(internal.migrations.resetStaleData.clearTable, { table })
        total += res.deleted
        done = res.done
      }
      summary[table] = total
    }
    return summary
  },
})
