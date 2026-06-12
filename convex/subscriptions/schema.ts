/**
 * Subscriptions table — one row per Anthropic Claude Code account the
 * vault holds for a single Clerk-authenticated owner.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §4.
 */
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * A usage window is a discriminated union of two states:
 *
 *  - **active** `{ pct, resetsAt, fetchedAt }` — Anthropic reported a live
 *    rate-limit window. This is also the legacy shape, so existing rows
 *    validate unchanged (no migration needed).
 *  - **idle** `{ idle: true, fetchedAt }` — a successful poll found NO active
 *    window (e.g. a 5h session window that has reset; the account is idle and
 *    a fresh window only starts on the next `claude` command). The dashboard
 *    renders the 5h idle state as "Ready".
 *
 * `undefined` (the field absent entirely) still means "never successfully
 * polled" — distinct from a confirmed idle window. The poll writes `active`
 * or `idle` on every success; it never writes `undefined`.
 */
export const activeUsageWindowValidator = v.object({
  pct: v.number(),
  resetsAt: v.number(),
  fetchedAt: v.number(),
})
export const idleUsageWindowValidator = v.object({
  idle: v.literal(true),
  fetchedAt: v.number(),
})
export const usageWindowValidator = v.union(activeUsageWindowValidator, idleUsageWindowValidator)

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
  usage5h: v.optional(usageWindowValidator),
  usage7d: v.optional(usageWindowValidator),
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
