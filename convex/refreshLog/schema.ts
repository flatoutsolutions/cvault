/**
 * Refresh log — one row per OAuth refresh attempt (manual, on-use).
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §4.
 *
 * SECURITY: `error` text is run through redactTokens() before insert
 * to ensure plaintext OAuth tokens are never persisted here.
 *
 * NOTE on `triggeredBy`: the `'cron'` literal is retained ONLY for
 * historical rows from before the `refreshExpiringTokens` cron was
 * dropped (audit fix #5 / cron-drop in PR #22). No production caller
 * emits `'cron'` anymore — this is a read-only legacy value. Removing
 * it from the union breaks `convex deploy` schema validation against
 * any deployment with pre-existing rows. A future migration that
 * back-fills `'cron'` rows to `'manual'` (or deletes them) would let
 * us narrow the union; until then, keep the literal.
 */
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const refreshLogSchema = defineTable({
  userId: v.id('users'),
  subscriptionId: v.id('subscriptions'),
  triggeredBy: v.union(v.literal('cron'), v.literal('manual'), v.literal('onUse')),
  outcome: v.union(v.literal('success'), v.literal('failure'), v.literal('reloginRequired')),
  error: v.optional(v.string()),
  at: v.number(),
})
  .index('bySubscriptionAndAt', ['subscriptionId', 'at'])
  .index('byUserAndAt', ['userId', 'at'])
  // Global by-time index — backs `queries.recentForUser`, which under the
  // shared-vault contract (`convex/utils/users.ts:3-7`) returns refresh
  // attempts across ALL users, not just the caller's. `byUserAndAt` is
  // retained for any future per-user drilldown but is no longer used by
  // the unscoped recent feed. Adding an index is zero-downtime.
  .index('byAt', ['at'])
