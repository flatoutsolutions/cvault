/**
 * Subscriptions table — one row per Anthropic Claude Code account the
 * vault holds for a single Clerk-authenticated owner.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §4.
 */
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const subscriptionsSchema = defineTable({
  userId: v.id('users'),
  email: v.string(),
  slot: v.number(),
  label: v.optional(v.string()),
  ciphertext: v.bytes(),
  nonce: v.bytes(),
  /**
   * Identifier of the master key version used to encrypt `ciphertext`.
   * `undefined` means "v1" (legacy rows written before key versioning).
   * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §3.
   */
  keyVersion: v.optional(v.string()),
  expiresAt: v.number(),
  refreshExpiresAt: v.optional(v.number()),
  subscriptionType: v.string(),
  rateLimitTier: v.string(),
  lastRefreshedAt: v.number(),
  refreshLeaseHolder: v.optional(v.string()),
  refreshLeaseUntil: v.optional(v.number()),
  usage5h: v.optional(
    v.object({
      pct: v.number(),
      resetsAt: v.number(),
      fetchedAt: v.number(),
    })
  ),
  usage7d: v.optional(
    v.object({
      pct: v.number(),
      resetsAt: v.number(),
      fetchedAt: v.number(),
    })
  ),
  removedAt: v.optional(v.number()),
})
  .index('byUserAndSlot', ['userId', 'slot'])
  .index('byUserAndEmail', ['userId', 'email'])
  // Cross-user email lookup for the shared-vault read path. See
  // `convex/utils/users.ts:3-7` — any authenticated identity reads any row,
  // so `getMetaByEmail` resolves by email globally. The legacy
  // `byUserAndEmail` index is retained because `internalReads` still uses
  // (userId, email) keys for cron-path internal queries; index additions
  // are zero-downtime, removals would need a migration commit.
  .index('byEmail', ['email'])
  .index('byExpiry', ['expiresAt'])
