/**
 * Refresh log — one row per OAuth refresh attempt (cron, manual, on-use).
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §4.
 *
 * SECURITY: `error` text is run through redactTokens() before insert
 * to ensure plaintext OAuth tokens are never persisted here.
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
