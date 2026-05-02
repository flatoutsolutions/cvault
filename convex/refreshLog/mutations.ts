/**
 * Internal mutation to insert a refreshLog row.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §4 + §6.
 *
 * SECURITY: callers MUST run any user-controlled string through
 * `subscriptions/redact.ts:redactTokens()` before passing it as `error`.
 * The schema does not enforce this — the action layer does, and tests
 * cover the redaction path.
 */
import { v } from 'convex/values'

import { internalMutation } from '../_generated/server'

export const insert = internalMutation({
  args: {
    userId: v.id('users'),
    subscriptionId: v.id('subscriptions'),
    triggeredBy: v.union(v.literal('cron'), v.literal('manual'), v.literal('onUse')),
    outcome: v.union(v.literal('success'), v.literal('failure'), v.literal('reloginRequired')),
    error: v.optional(v.string()),
    at: v.number(),
  },
  returns: v.id('refreshLog'),
  handler: async (ctx, args) => {
    return await ctx.db.insert('refreshLog', args)
  },
})
