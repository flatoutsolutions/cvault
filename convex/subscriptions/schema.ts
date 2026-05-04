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
  // Cross-user email lookup for ALL active read AND write paths. See
  // `convex/utils/users.ts:3-7` — any authenticated identity reads/writes
  // any row. Used by:
  //  - `getMetaByEmail` (queries.ts) — read path
  //  - `getSubscriptionBySlotOrEmail` (internalReads.ts) — read path
  //  - `softRemove` / `rename` (mutations.ts) — public mutation path,
  //    unscoped so cross-user `cvault remove` / `cvault rename` succeed
  //    under shared vault.
  //  - `upsertSub` (mutations.ts) — write-dedupe path, also unscoped
  //    (audit fix; pre-fix used a per-user index which let two Clerk
  //    users add the same Anthropic email and end up with duplicate
  //    rows for one address).
  // Key rotation (`listSubsForRotation`) and backup export
  // (`listAllActiveSubsRaw`) are vault-wide and don't use this index.
  // Index additions are zero-downtime; removals would need a migration.
  .index('byEmail', ['email'])
