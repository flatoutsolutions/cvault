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
  // Cross-user email lookup for the shared-vault read AND public-mutation
  // paths. See `convex/utils/users.ts:3-7` — any authenticated identity
  // reads/writes any row. Used by:
  //  - `getMetaByEmail` (queries.ts) — read path
  //  - `getSubscriptionBySlotOrEmail` (internalReads.ts) — read path
  //  - `softRemove` / `rename` (mutations.ts) — public mutation path,
  //    unscoped here so cross-user `cvault remove` / `cvault rename`
  //    succeed under shared vault.
  // The legacy `byUserAndEmail` index is retained because `upsertSub`
  // (mutations.ts) still uses it for per-user write dedupe — that's a
  // deliberate scope decision, not parity drift. Key rotation
  // (`listSubsForRotation`) and backup export (`listAllActiveSubsRaw`)
  // are vault-wide and don't use either index. Index additions are
  // zero-downtime; removals would need a migration commit.
  .index('byEmail', ['email'])
  .index('byExpiry', ['expiresAt'])
