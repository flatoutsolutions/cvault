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
    v.literal('login')
  ),
  subscriptionId: v.optional(v.id('subscriptions')),
  at: v.number(),
  ipHash: v.optional(v.string()),
})
  .index('byUserAndAt', ['userId', 'at'])
  .index('byUserAndSessionAndAt', ['userId', 'clerkSessionId', 'at'])
