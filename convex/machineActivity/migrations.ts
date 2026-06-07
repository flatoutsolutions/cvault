/**
 * One-shot, idempotent backfill for the CVLT-3 `clerkSessionId` → `machineId`
 * rename on `machineActivity`.
 *
 * Run AFTER deploying the schema change that made `machineId` optional + re-added
 * `clerkSessionId` optional (see `schema.ts` migration note). For every legacy
 * row that has a `clerkSessionId` but no `machineId`, copy the session id into
 * `machineId` so the audit feed, per-machine drill-down, and assignments read
 * paths surface the row under a stable key without relying on the read-time
 * coalesce. Idempotent: rows that already have a `machineId` are skipped, so it
 * is safe to re-run (e.g. across pagination batches or after a partial run).
 *
 * Invoke from the Convex dashboard or CLI:
 *   npx convex run machineActivity/migrations:backfillMachineId '{}'
 * Re-run until `done: true` (each call processes up to `BATCH` rows).
 */
import { v } from 'convex/values'

import { internalMutation } from '../_generated/server'

/** Rows processed per invocation — keeps each mutation well under Convex limits. */
const BATCH = 500

export const backfillMachineId = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({
    patched: v.number(),
    scanned: v.number(),
    done: v.boolean(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db
      .query('machineActivity')
      .withIndex('byAt')
      .paginate({ numItems: BATCH, cursor: cursor ?? null })

    let patched = 0
    for (const row of result.page) {
      if (row.machineId !== undefined) continue
      if (row.clerkSessionId === undefined) continue
      await ctx.db.patch('machineActivity', row._id, { machineId: row.clerkSessionId })
      patched += 1
    }

    return {
      patched,
      scanned: result.page.length,
      done: result.isDone,
      cursor: result.isDone ? null : result.continueCursor,
    }
  },
})
