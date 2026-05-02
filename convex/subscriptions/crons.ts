'use node'

/**
 * Cron worker actions for the subscriptions domain.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5 + §10.
 *
 * The actual schedule is in `convex/crons.ts`. These files just export
 * the work functions, which are internalAction so the cron is the only
 * possible caller.
 */
import { v } from 'convex/values'

import { internal } from '../_generated/api'
import { internalAction } from '../_generated/server'

/** Window before access-token expiry that triggers a proactive refresh. */
const REFRESH_WINDOW_MS = 15 * 60 * 1000

/**
 * Scan for subs whose access token expires within the next 15 minutes
 * and schedule a refresh for each. Per spec §5 + §10, per-sub errors
 * MUST NOT abort the whole batch — `refreshOAuthToken` self-logs via
 * `refreshLog`, but if its handler throws unexpectedly we want the
 * remaining subs to still get their chance. `Promise.allSettled` gives
 * us per-sub error isolation; we surface rejections via `console.error`
 * so they show up in Convex logs even when the sub-level audit row
 * couldn't be written.
 */
export const refreshExpiringTokens = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const expiring = await ctx.runQuery(internal.subscriptions.internalReads.findExpiringSubs, {
      withinMs: REFRESH_WINDOW_MS,
    })

    const results = await Promise.allSettled(
      expiring.map((row) =>
        ctx.runAction(internal.subscriptions.actions.refreshOAuthToken, {
          subId: row.subId,
          triggeredBy: 'cron',
        })
      )
    )
    for (const [idx, r] of results.entries()) {
      if (r.status === 'rejected') {
        const subId = expiring[idx]?.subId ?? 'unknown'
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
        console.error(
          `[cvault] refreshExpiringTokens: sub ${String(subId)} threw unhandled: ${reason}`
        )
      }
    }
    return null
  },
})

/**
 * Fan out usage fetches across every active sub. Failures are silent
 * per spec §10 (next 5-minute tick will retry). We use `Promise.allSettled`
 * so one sub's transient failure doesn't abort the whole batch; the
 * action itself swallows non-fatal errors, but `allSettled` is the
 * defensive default for a fanout that explicitly opts in to silent
 * per-sub failure.
 */
export const pollUsage = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const active = await ctx.runQuery(internal.subscriptions.internalReads.listAllActiveSubIds, {})
    const results = await Promise.allSettled(
      active.map((row) =>
        ctx.runAction(internal.subscriptions.actions.fetchUsageForSub, {
          subId: row.subId,
        })
      )
    )
    for (const [idx, r] of results.entries()) {
      if (r.status === 'rejected') {
        const subId = active[idx]?.subId ?? 'unknown'
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
        console.error(
          `[cvault] pollUsage: sub ${String(subId)} threw unhandled: ${reason}`
        )
      }
    }
    return null
  },
})
