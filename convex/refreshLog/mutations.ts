/**
 * Internal mutation to insert a refreshLog row.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §4 + §6.
 *
 * SECURITY: callers MUST run any user-controlled string through
 * `subscriptions/redact.ts:redactTokens()` before passing it as `error`.
 * The schema does not enforce this — the action layer does, and tests
 * cover the redaction path.
 *
 * DEDUPE: `reloginRequired` rows for the same subscription are silently
 * collapsed when the prior `reloginRequired` for that sub landed within
 * `RELOGIN_DEDUPE_WINDOW_MS`. The motivating bug was the
 * `refreshExpiringTokens` cron repeatedly hitting Anthropic against
 * RT-dead subs and generating identical `reloginRequired` rows every
 * tick. The cron itself was removed in v1 (audit fix #5); this dedupe
 * is the last line of defense for any direct CLI caller (`cvault
 * refresh`) or future code path that bypasses the in-action
 * `refreshExpiresAt` short-circuit.
 *
 * `failure` and `success` rows are NEVER deduped — they are meaningful
 * per-attempt and the dashboard's audit feed needs every one.
 */
import { v } from 'convex/values'

import { internalMutation } from '../_generated/server'

const RELOGIN_DEDUPE_WINDOW_MS = 5 * 60 * 1000

export const insert = internalMutation({
  args: {
    userId: v.id('users'),
    subscriptionId: v.id('subscriptions'),
    triggeredBy: v.union(v.literal('manual'), v.literal('onUse')),
    outcome: v.union(v.literal('success'), v.literal('failure'), v.literal('reloginRequired')),
    error: v.optional(v.string()),
    at: v.number(),
  },
  returns: v.union(v.id('refreshLog'), v.null()),
  handler: async (ctx, args) => {
    if (args.outcome === 'reloginRequired') {
      // Read the most recent refreshLog row for this sub via the
      // existing `bySubscriptionAndAt` index. `desc` order + `first()`
      // means we only fetch one row regardless of history depth.
      const last = await ctx.db
        .query('refreshLog')
        .withIndex('bySubscriptionAndAt', (q) => q.eq('subscriptionId', args.subscriptionId))
        .order('desc')
        .first()
      if (last !== null && last.outcome === 'reloginRequired' && args.at - last.at < RELOGIN_DEDUPE_WINDOW_MS) {
        // Silently drop. Returning `null` lets the caller distinguish
        // "deduped" from "inserted" if it ever needs to (none currently do).
        return null
      }
    }
    return await ctx.db.insert('refreshLog', args)
  },
})
