/**
 * Internal queries that return raw subscription rows (including ciphertext +
 * nonce). These are NEVER exposed publicly — only Convex actions in this
 * codebase call them via runQuery.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5 (actions need
 * the encrypted blob to decrypt; queries can't return it).
 */
import { v } from 'convex/values'

import { internalQuery } from '../_generated/server'

const subscriptionRawValidator = v.object({
  _id: v.id('subscriptions'),
  _creationTime: v.number(),
  userId: v.id('users'),
  email: v.string(),
  slot: v.number(),
  label: v.optional(v.string()),
  ciphertext: v.bytes(),
  nonce: v.bytes(),
  keyVersion: v.optional(v.string()),
  expiresAt: v.number(),
  refreshExpiresAt: v.optional(v.number()),
  subscriptionType: v.string(),
  rateLimitTier: v.string(),
  lastRefreshedAt: v.number(),
  refreshLeaseHolder: v.optional(v.string()),
  refreshLeaseUntil: v.optional(v.number()),
  usage5h: v.optional(v.object({ pct: v.number(), resetsAt: v.number(), fetchedAt: v.number() })),
  usage7d: v.optional(v.object({ pct: v.number(), resetsAt: v.number(), fetchedAt: v.number() })),
  removedAt: v.optional(v.number()),
})

export const getSubscriptionRaw = internalQuery({
  args: { subId: v.id('subscriptions') },
  returns: v.union(subscriptionRawValidator, v.null()),
  handler: async (ctx, { subId }) => {
    return await ctx.db.get('subscriptions', subId)
  },
})

/**
 * Look up a sub by either numeric slot or email. SHARED-VAULT semantics —
 * any authenticated allowed-domain caller resolves any row (see
 * `convex/utils/users.ts:3-7`). Authorization is enforced by the calling
 * action's `authenticatedAction` wrapper (Clerk identity present + email
 * on the `allowedEmailDomains` allowlist); this internal query has no
 * additional access policy and DOES NOT scope by caller's `users._id`.
 *
 * Pre-hotfix this query took an `externalId` arg and scoped to the
 * caller's user via `byUserAndSlot` / `byUserAndEmail`, which produced
 * NOT_FOUND for `cvault sync --all` whenever the acting machine's owner
 * differed from the sub's nominal owner. The contract was wrong; this
 * is the corrected version.
 *
 * Email branch: index lookup via `byEmail` (lowercased to match the
 * storage canonicalization in `mutations.ts:canonicalEmail`).
 *
 * Slot branch: rare path — the CLI normally uses email; only legacy
 * `cvault switch <slot>` invocations end up here. Per the user's design
 * ("locally any number, on the web FCFS"), the slot input is interpreted
 * as a FCFS RANK ORDINAL on the global active table:
 *   `1` = oldest non-removed sub by `_creationTime`
 *   `2` = second-oldest, …
 *   `N+1` = null (out of bounds)
 *
 * The stored `slot` column is per-user and ambiguous globally (two users'
 * first subs both have stored slot=1), so matching against it produces
 * the wrong answer cross-tenant — the bug behind `cvault switch 2` 404s
 * in prod. The stored column is retained on the row only so shipped CLIs
 * that print it in `cvault list` keep working; it is no longer used for
 * lookups. `order('asc')` on the system `_creationTime` is the index
 * ordering Convex defaults to when no `withIndex` is specified.
 */
export const getSubscriptionBySlotOrEmail = internalQuery({
  args: { slotOrEmail: v.string() },
  returns: v.union(subscriptionRawValidator, v.null()),
  handler: async (ctx, { slotOrEmail }) => {
    const asNum = Number.parseInt(slotOrEmail, 10)
    if (!Number.isNaN(asNum) && asNum.toString() === slotOrEmail) {
      // FCFS rank-ordinal lookup. Filter to live rows first, then index
      // into the resulting array. A naive `r.slot === asNum` match would
      // match the per-user stored column, which is structurally wrong
      // under shared-vault — see the function-level comment.
      const live = (await ctx.db.query('subscriptions').order('asc').collect()).filter((r) => r.removedAt === undefined)
      // Off-by-one note: the user-facing rank is 1-based; the array is
      // 0-based. `live[asNum - 1]` returns undefined for asNum < 1 or
      // asNum > live.length, both of which we surface as null.
      if (asNum < 1) return null
      return live[asNum - 1] ?? null
    }

    const subs = await ctx.db
      .query('subscriptions')
      .withIndex('byEmail', (q) => q.eq('email', slotOrEmail.toLowerCase()))
      .collect()
    const sub = subs.find((s) => s.removedAt === undefined)
    return sub ?? null
  },
})

/**
 * Resolve a sub by id. SHARED-VAULT semantics — see
 * `getSubscriptionBySlotOrEmail` above. The caller's `authenticatedAction`
 * wrapper is the only access gate; this query intentionally has no
 * ownership check.
 *
 * Returns `null` for soft-removed rows so callers don't have to filter
 * `removedAt` themselves.
 */
export const getSubscriptionById = internalQuery({
  args: { subId: v.id('subscriptions') },
  returns: v.union(subscriptionRawValidator, v.null()),
  handler: async (ctx, { subId }) => {
    const sub = await ctx.db.get('subscriptions', subId)
    if (!sub || sub.removedAt !== undefined) return null
    return sub
  },
})

/**
 * How far back the cron looks for already-expired tokens whose refresh
 * tokens may still be valid. Anthropic refresh tokens are valid ~30 days
 * (per docs/research/anthropic-oauth-refresh.md); a row whose access
 * token expired before this lookback floor is unrecoverable, and
 * including it in the scan only burns index bandwidth.
 *
 * The motivating perf bug (Track B item 10): the prior implementation
 * scanned `byExpiry` from the lowest-historical `expiresAt` up to the
 * cutoff with NO lower bound, which dragged in long-tombstoned rows.
 * The `removedAt === undefined` JS filter still excluded them from the
 * result, but the read amplification was unbounded as the table grew.
 */
const RECOVERABLE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A sub is "RT dead" once `markReloginRequired` clamps `refreshExpiresAt`
 * to `Date.now()` after Anthropic answered `invalid_grant`. Dead subs MUST
 * be excluded from cron scans — otherwise every tick re-drives Anthropic
 * (burns an API call), logs a fresh `reloginRequired` row (spam), and
 * gives the user nothing they didn't already know. Recovery requires the
 * user to `cvault add` again on a machine that holds a fresh blob; until
 * that happens, the cron has no productive work to do.
 *
 * `refreshExpiresAt === undefined` is treated as "alive" because legacy /
 * never-refreshed rows lack the field — excluding them would silently
 * drop every sub created before RT-tracking landed.
 */
function isReloginRequired(row: { refreshExpiresAt?: number }, now: number): boolean {
  return row.refreshExpiresAt !== undefined && row.refreshExpiresAt <= now
}

/** Internal query used by the cron to find subs whose access token expires soon. */
export const findExpiringSubs = internalQuery({
  args: { withinMs: v.number() },
  returns: v.array(v.object({ subId: v.id('subscriptions') })),
  handler: async (ctx, { withinMs }) => {
    const now = Date.now()
    const cutoff = now + withinMs
    const floor = now - RECOVERABLE_LOOKBACK_MS
    const rows = await ctx.db
      .query('subscriptions')
      .withIndex('byExpiry', (q) => q.gt('expiresAt', floor).lt('expiresAt', cutoff))
      .collect()
    // Filter out tombstoned subs in JS (low cardinality of soft-deletes per spec §4).
    // Also exclude RT-dead subs — see `isReloginRequired` above.
    return rows.filter((r) => r.removedAt === undefined && !isReloginRequired(r, now)).map((r) => ({ subId: r._id }))
  },
})

/** Internal query used by the usage cron — list every active sub. */
export const listAllActiveSubIds = internalQuery({
  args: {},
  returns: v.array(v.object({ subId: v.id('subscriptions') })),
  handler: async (ctx) => {
    const now = Date.now()
    const rows = await ctx.db.query('subscriptions').collect()
    // Polling usage with a dead access token is wasted work — the next
    // refresh cycle won't be able to recover it without user re-capture.
    return rows.filter((r) => r.removedAt === undefined && !isReloginRequired(r, now)).map((r) => ({ subId: r._id }))
  },
})

/**
 * Internal query returning rows whose keyVersion does not match the supplied
 * targetVersion. Used by `rotateAllSubscriptions` to find work to do.
 *
 * Returns the full row (ciphertext + nonce + keyVersion) so the action
 * can decrypt without a second read.
 *
 * Vault-wide: per the shared-vault model (`convex/utils/users.ts:3-7`),
 * there is ONE master AES key encrypting every row. Rotating that key
 * is therefore vault-wide by definition — there's no useful semantics
 * for "rotate only my rows" because all rows decrypt under the same
 * key. Pre-fix this query took a `userId` arg and scoped to that user's
 * rows, which left other users' rows stuck on the prior key version
 * (silently broken decrypt for the cron once the previous key was
 * dropped from `VAULT_AES_KEY_PREVIOUS`). Caller in
 * `keyRotationJobs/actions.ts` updated to stop passing the arg.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §5.
 */
export const listSubsForRotation = internalQuery({
  args: { targetVersion: v.string() },
  returns: v.array(subscriptionRawValidator),
  handler: async (ctx, { targetVersion }) => {
    const rows = await ctx.db.query('subscriptions').collect()
    return rows.filter((r) => r.removedAt === undefined && (r.keyVersion ?? 'v1') !== targetVersion)
  },
})

/**
 * Internal query returning every active sub in the vault. Used by the
 * backup export action and the import-time collision check.
 *
 * Vault-wide: per the shared-vault model (`convex/utils/users.ts:3-7`),
 * the backup bundle holds the entire vault. Pre-fix this query was named
 * `listSubsForUserId` and scoped to the caller's `users._id`, so an
 * `cvault export` from one co-tenant left the other co-tenants' rows
 * outside the disaster-recovery archive — defeating the point of a
 * shared vault. Renamed to make the new contract explicit.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
 */
export const listAllActiveSubsRaw = internalQuery({
  args: {},
  returns: v.array(subscriptionRawValidator),
  handler: async (ctx) => {
    const rows = await ctx.db.query('subscriptions').collect()
    return rows.filter((r) => r.removedAt === undefined)
  },
})
