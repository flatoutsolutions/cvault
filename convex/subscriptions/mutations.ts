/**
 * Subscriptions mutations.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5 + §9.
 *
 * Public mutations are routed through `authenticatedMutation` so the
 * caller's Clerk identity is verified before any DB read.
 *
 * Internal mutations exist for refresh-cycle bookkeeping (called by
 * Convex actions only) and for the `upsertEncrypted` path that the
 * `upsertFromPlaintext` action delegates to after encrypting.
 */
import { ConvexError, v } from 'convex/values'

import { type Doc, type Id } from '../_generated/dataModel'
import { type MutationCtx, internalMutation } from '../_generated/server'
import { authenticatedMutation, getIdentity } from '../utils/auth'
import { resolveCallerSession } from '../utils/identity'
import { getCurrentUserOrThrowFromIdentity } from '../utils/users'

type ActivityAction = 'switch' | 'add' | 'pull' | 'remove' | 'refresh' | 'rename'

/**
 * Insert a `machineActivity` row directly via `ctx.db.insert` (rather
 * than via the `internal.machineActivity.mutations.record` ipHash mutation)
 * because (a) we never have a raw IP at the public-mutation entry — they
 * arrive over the WebSocket — and (b) staying inside the mutation lets
 * the activity-row insert participate in the same transaction as the
 * subscription mutation, so a failure post-insert atomically rolls back.
 *
 * `machineLabel` is the human-readable identifier the dashboard shows
 * for each Clerk session. Mutations called from the CLI forward
 * `session.machineLabel` here; mutations called from the dashboard pass
 * `undefined` (browser callers don't have a hostname).
 */
async function recordActivity(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    action: ActivityAction
    subscriptionId?: Id<'subscriptions'>
    machineLabel?: string
    /**
     * Caller's Clerk session id, supplied by the CLI as an action arg
     * (BAPI-minted JWTs lack the `sid` claim — see `utils/identity.ts`).
     * Optional; falls back to `identity.sid` (FAPI/dashboard origin)
     * then to the `unknown-session` sentinel.
     */
    clerkSessionId?: string
  }
): Promise<void> {
  await ctx.db.insert('machineActivity', {
    userId: args.userId,
    clerkSessionId: resolveCallerSession(getIdentity(ctx), args.clerkSessionId),
    action: args.action,
    subscriptionId: args.subscriptionId,
    at: Date.now(),
    machineLabel: args.machineLabel,
    // No ipHash here — see helper docstring.
  })
}

/**
 * Allocate the next free slot for `userId`. Slots are per-user, 1-indexed,
 * and we fill the lowest gap so removed-then-readded subs stay compact.
 *
 * Uses the `byUserAndSlot` index to bound the scan to one user's rows.
 * The previous implementation called `.collect()` on the entire global
 * subscriptions table on every insert/revive, which was both unbounded
 * and incorrectly conflated slot spaces across users.
 */
async function nextFreeSlotForUser(ctx: MutationCtx, userId: Doc<'users'>['_id']): Promise<number> {
  const rows = await ctx.db
    .query('subscriptions')
    .withIndex('byUserAndSlot', (q) => q.eq('userId', userId))
    .collect()
  const taken = new Set<number>()
  for (const r of rows) {
    if (r.removedAt === undefined) {
      taken.add(r.slot)
    }
  }
  let candidate = 1
  while (taken.has(candidate)) {
    candidate += 1
  }
  return candidate
}

const upsertResultValidator = v.object({
  subId: v.id('subscriptions'),
  userId: v.id('users'),
  slot: v.number(),
  created: v.boolean(),
})

interface UpsertSubInput {
  userId: Id<'users'>
  email: string
  ciphertext: ArrayBuffer
  nonce: ArrayBuffer
  expiresAt: number
  refreshExpiresAt?: number
  subscriptionType: string
  rateLimitTier: string
  label?: string
}

interface UpsertSubResult {
  subId: Id<'subscriptions'>
  userId: Id<'users'>
  slot: number
  created: boolean
}

/**
 * Canonicalize an email for storage and lookup. Anthropic emails are
 * case-insensitive at SMTP and Clerk normalizes inconsistently — without
 * this, `cvault add Stefan@x.com` followed by `cvault remove
 * stefan@x.com` would NOT_FOUND because the `byUserAndEmail` index does
 * an exact-string comparison.
 *
 * Lowercasing is applied at every WRITE (so stored emails are always
 * canonical) and at every email-keyed LOOKUP (so old mixed-case input
 * still matches in-flight requests). Since this branch
 * (`feat/production-deployment`) hasn't shipped, no migration is
 * required — but the lookup-side normalization is the safety net if
 * any mixed-case rows snuck in via earlier dev installs.
 */
function canonicalEmail(email: string): string {
  return email.toLowerCase()
}

/**
 * Shared upsert logic used by both `upsert` (caller already has ciphertext)
 * and `upsertEncrypted` (called by the `upsertFromPlaintext` action after
 * encrypting plaintext server-side).
 *
 * Behavior:
 *  - existing live row -> rotate ciphertext+nonce in place, keep slot stable
 *  - existing tombstoned row -> revive in place, keep slot, clear removedAt
 *  - no row -> allocate next free slot via `nextFreeSlot()` and insert
 */
async function upsertSub(ctx: MutationCtx, input: UpsertSubInput): Promise<UpsertSubResult> {
  // Canonicalize the incoming email once. Stored emails are lowercase
  // and lookup keys are lowercase so dedupe matches regardless of how
  // Anthropic / Clerk happened to capitalize the same address.
  const email = canonicalEmail(input.email)

  // Dedupe by (userId, email). The `byUserAndEmail` index makes this
  // an O(matches) read instead of an O(allSubsGlobal) scan; matches per
  // (user, email) is at most 1 by spec.
  const existing = await ctx.db
    .query('subscriptions')
    .withIndex('byUserAndEmail', (q) => q.eq('userId', input.userId).eq('email', email))
    .unique()

  const now = Date.now()

  if (existing && existing.removedAt === undefined) {
    await ctx.db.patch('subscriptions', existing._id, {
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      expiresAt: input.expiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
      subscriptionType: input.subscriptionType,
      rateLimitTier: input.rateLimitTier,
      lastRefreshedAt: now,
      ...(input.label !== undefined ? { label: input.label } : {}),
    })
    return { subId: existing._id, userId: input.userId, slot: existing.slot, created: false }
  }

  if (existing && existing.removedAt !== undefined) {
    // Reviving a tombstoned row: re-allocate to the lowest free slot
    // (per user) instead of preserving the tombstoned slot. Otherwise
    // removing slots 1+2 then re-adding email-from-slot-2 would silently
    // revive at slot 2 and leave slot 1 hole — confusing for users who
    // expect dense slot numbers.
    const reviveSlot = await nextFreeSlotForUser(ctx, input.userId)
    await ctx.db.patch('subscriptions', existing._id, {
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      slot: reviveSlot,
      expiresAt: input.expiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
      subscriptionType: input.subscriptionType,
      rateLimitTier: input.rateLimitTier,
      lastRefreshedAt: now,
      removedAt: undefined,
      ...(input.label !== undefined ? { label: input.label } : {}),
    })
    return { subId: existing._id, userId: input.userId, slot: reviveSlot, created: false }
  }

  // Slot space is per-user (was global — that conflated different users'
  // slot allocations and grew O(allSubs) per insert).
  const slot = await nextFreeSlotForUser(ctx, input.userId)

  const subId = await ctx.db.insert('subscriptions', {
    userId: input.userId,
    email,
    slot,
    label: input.label,
    ciphertext: input.ciphertext,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
    refreshExpiresAt: input.refreshExpiresAt,
    subscriptionType: input.subscriptionType,
    rateLimitTier: input.rateLimitTier,
    lastRefreshedAt: now,
  })

  return { subId, userId: input.userId, slot, created: true }
}

export const upsert = authenticatedMutation({
  args: {
    email: v.string(),
    ciphertext: v.bytes(),
    nonce: v.bytes(),
    expiresAt: v.number(),
    refreshExpiresAt: v.optional(v.number()),
    subscriptionType: v.string(),
    rateLimitTier: v.string(),
    label: v.optional(v.string()),
  },
  returns: upsertResultValidator,
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrThrowFromIdentity(ctx, getIdentity(ctx).subject)
    return await upsertSub(ctx, { ...args, userId: user._id })
  },
})

/**
 * Internal-only path used by the `upsertFromPlaintext` Node action: the
 * action does the AES-GCM encrypt under VAULT_AES_KEY, then calls this
 * mutation with the resulting ciphertext+nonce. We accept `externalId`
 * directly so the action's pre-resolved Clerk subject is the source of
 * truth (no duplicate identity lookup).
 */
export const upsertEncrypted = internalMutation({
  args: {
    externalId: v.string(),
    email: v.string(),
    ciphertext: v.bytes(),
    nonce: v.bytes(),
    expiresAt: v.number(),
    refreshExpiresAt: v.optional(v.number()),
    subscriptionType: v.string(),
    rateLimitTier: v.string(),
    label: v.optional(v.string()),
  },
  returns: upsertResultValidator,
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrThrowFromIdentity(ctx, args.externalId)
    return await upsertSub(ctx, { ...args, userId: user._id })
  },
})

export const softRemove = authenticatedMutation({
  args: {
    email: v.string(),
    /**
     * Human-readable identifier for the originating CLI machine. The
     * dashboard's "Machines" view renders this as the user-visible
     * label per Clerk session. Optional — see
     * `machineActivity/schema.ts:machineLabel` for the contract.
     */
    machineLabel: v.optional(v.string()),
    /**
     * Caller's Clerk session id. Required for BAPI-minted CLI JWTs that
     * lack a `sid` claim. See `utils/identity.ts`.
     */
    clerkSessionId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { email, machineLabel, clerkSessionId }) => {
    const user = await getCurrentUserOrThrowFromIdentity(ctx, getIdentity(ctx).subject)

    // SECURITY+PERF: scope to (userId, email). Pre-fix used `.filter()` on
    // a global table and would accept the first row matching the email
    // regardless of owner — would let any signed-in user soft-remove any
    // other user's sub (NOT_FOUND-by-luck, not by-policy).
    //
    // Email is canonicalized to lowercase to match the storage convention
    // set in `upsertSub`. Without this, `cvault remove Stefan@x.com`
    // when the row was stored as `stefan@x.com` would NOT_FOUND.
    const sub = await ctx.db
      .query('subscriptions')
      .withIndex('byUserAndEmail', (q) => q.eq('userId', user._id).eq('email', canonicalEmail(email)))
      .unique()

    if (!sub || sub.removedAt !== undefined) {
      throw new ConvexError({ code: 'NOT_FOUND', message: `Subscription not found for email: ${email}` })
    }

    await ctx.db.patch('subscriptions', sub._id, { removedAt: Date.now() })
    await recordActivity(ctx, {
      userId: user._id,
      action: 'remove',
      subscriptionId: sub._id,
      ...(machineLabel !== undefined ? { machineLabel } : {}),
      ...(clerkSessionId !== undefined ? { clerkSessionId } : {}),
    })
    return null
  },
})

export const rename = authenticatedMutation({
  args: {
    email: v.string(),
    label: v.string(),
    /** See softRemove docstring. */
    machineLabel: v.optional(v.string()),
    /** See softRemove docstring. */
    clerkSessionId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { email, label, machineLabel, clerkSessionId }) => {
    const user = await getCurrentUserOrThrowFromIdentity(ctx, getIdentity(ctx).subject)

    // Same scoping + canonicalization rule as `softRemove` above.
    const sub = await ctx.db
      .query('subscriptions')
      .withIndex('byUserAndEmail', (q) => q.eq('userId', user._id).eq('email', canonicalEmail(email)))
      .unique()

    if (!sub || sub.removedAt !== undefined) {
      throw new ConvexError({ code: 'NOT_FOUND', message: `Subscription not found for email: ${email}` })
    }

    await ctx.db.patch('subscriptions', sub._id, { label })
    await recordActivity(ctx, {
      userId: user._id,
      action: 'rename',
      subscriptionId: sub._id,
      ...(machineLabel !== undefined ? { machineLabel } : {}),
      ...(clerkSessionId !== undefined ? { clerkSessionId } : {}),
    })
    return null
  },
})

// ---------------------------------------------------------------------------
// Refresh-race protection (spec §9). Internal-only — called by actions.
// ---------------------------------------------------------------------------

const LEASE_TTL_MS = 30_000

export const tryAcquireRefreshLease = internalMutation({
  args: {
    subId: v.id('subscriptions'),
    holderToken: v.string(),
  },
  returns: v.object({ acquired: v.boolean() }),
  handler: async (ctx, { subId, holderToken }) => {
    const sub = await ctx.db.get('subscriptions', subId)
    if (!sub) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Subscription does not exist' })
    }

    const now = Date.now()
    if (sub.refreshLeaseUntil !== undefined && sub.refreshLeaseUntil > now) {
      return { acquired: false }
    }

    await ctx.db.patch('subscriptions', subId, {
      refreshLeaseHolder: holderToken,
      refreshLeaseUntil: now + LEASE_TTL_MS,
    })
    return { acquired: true }
  },
})

export const releaseRefreshLease = internalMutation({
  args: {
    subId: v.id('subscriptions'),
    holderToken: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { subId, holderToken }) => {
    const sub = await ctx.db.get('subscriptions', subId)
    if (!sub) return null
    if (sub.refreshLeaseHolder !== holderToken) {
      // Defensively no-op rather than throwing - the lease may have already
      // expired and another holder taken over.
      return null
    }
    await ctx.db.patch('subscriptions', subId, {
      refreshLeaseHolder: undefined,
      refreshLeaseUntil: undefined,
    })
    return null
  },
})

export const commitRefreshedTokens = internalMutation({
  args: {
    subId: v.id('subscriptions'),
    holderToken: v.string(),
    ciphertext: v.bytes(),
    nonce: v.bytes(),
    expiresAt: v.number(),
    refreshExpiresAt: v.optional(v.number()),
    lastRefreshedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const sub = await ctx.db.get('subscriptions', args.subId)
    if (!sub) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Subscription does not exist' })
    }
    if (sub.refreshLeaseHolder !== args.holderToken) {
      throw new ConvexError({
        code: 'LEASE_LOST',
        message: 'commitRefreshedTokens called by non-lease-holder; aborting',
      })
    }

    // CAS on `expiresAt`: if a parallel adoptLocalState / adopt-from-Anthropic
    // already pushed the row to a NEWER expiresAt, this commit's token
    // material is older — refusing to patch keeps the freshest token
    // material live. We still drop the lease (the lease holder did
    // legitimately complete its work; not releasing would force a 30s
    // TTL wait for the next attempt). Mirrors `adoptLocalState`'s CAS.
    if (args.expiresAt < sub.expiresAt) {
      await ctx.db.patch('subscriptions', args.subId, {
        refreshLeaseHolder: undefined,
        refreshLeaseUntil: undefined,
      })
      return null
    }

    await ctx.db.patch('subscriptions', args.subId, {
      ciphertext: args.ciphertext,
      nonce: args.nonce,
      expiresAt: args.expiresAt,
      refreshExpiresAt: args.refreshExpiresAt ?? sub.refreshExpiresAt,
      lastRefreshedAt: args.lastRefreshedAt,
      refreshLeaseHolder: undefined,
      refreshLeaseUntil: undefined,
    })
    return null
  },
})

/**
 * Internal mutation used by the usage cron action to patch usage cache.
 * Public callers cannot reach this.
 */
export const patchUsage = internalMutation({
  args: {
    subId: v.id('subscriptions'),
    usage5h: v.optional(v.object({ pct: v.number(), resetsAt: v.number(), fetchedAt: v.number() })),
    usage7d: v.optional(v.object({ pct: v.number(), resetsAt: v.number(), fetchedAt: v.number() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const sub = await ctx.db.get('subscriptions', args.subId)
    if (!sub) return null

    const patch: { usage5h?: typeof args.usage5h; usage7d?: typeof args.usage7d } = {}
    if (args.usage5h !== undefined) patch.usage5h = args.usage5h
    if (args.usage7d !== undefined) patch.usage7d = args.usage7d
    if (Object.keys(patch).length === 0) return null

    await ctx.db.patch('subscriptions', args.subId, patch)
    return null
  },
})

/**
 * Internal mutation used by `refreshSub` to adopt a CLI-supplied local
 * state when its embedded `claudeAiOauth.expiresAt` is strictly newer than
 * the row's. Encryption is done by the calling action (we accept ciphertext
 * + nonce here; mutations can't use `node:crypto`).
 *
 * CAS check: re-reads the row inside the transaction and only patches if
 * the row's `expiresAt` is still strictly less than the supplied
 * `localExpiresAt`. This guards against the race where two CLIs from two
 * machines both call `refreshSub` with their respective local states; the
 * second to land will see the first's adoption already applied and no-op.
 *
 * Upper-bound cap: a skewed laptop clock or a manipulated Keychain blob
 * can ship `expiresAt = Date.now() + 100 years`. If we adopted that, the
 * cron's `findExpiringSubs` window would never catch it (the `byExpiry`
 * index range query would always miss the future date) and the row would
 * be poisoned indefinitely. Anthropic's access-token lifetime is 8h; 24h
 * is a generous bound for clock skew. Any incoming `localExpiresAt` past
 * `Date.now() + 24h` is rejected (return `adopted: false`, log a warning
 * with redacted state).
 *
 * Returns whether the row was actually patched so the caller can decide
 * which `action` label to surface in its return payload.
 */
const ADOPT_MAX_FUTURE_MS = 24 * 60 * 60 * 1000

export const adoptLocalState = internalMutation({
  args: {
    subId: v.id('subscriptions'),
    ciphertext: v.bytes(),
    nonce: v.bytes(),
    localExpiresAt: v.number(),
  },
  returns: v.object({ adopted: v.boolean() }),
  handler: async (ctx, { subId, ciphertext, nonce, localExpiresAt }) => {
    const sub = await ctx.db.get('subscriptions', subId)
    if (!sub) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Subscription does not exist' })
    }
    if (sub.removedAt !== undefined) {
      // Don't resurrect a tombstoned sub via local adoption.
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Subscription has been removed' })
    }
    const now = Date.now()
    if (localExpiresAt > now + ADOPT_MAX_FUTURE_MS) {
      // Skewed clock or tampered blob — refuse to adopt and log a
      // warning. Logging redacts subId-only context (no token material is
      // present in this scope) so the operator can grep `[cvault]` to
      // see vault-poisoning attempts in Convex logs.
      console.warn(
        `[cvault] adoptLocalState: refusing to adopt out-of-bound expiresAt for ` +
          `subId=${String(subId)} (localExpiresAt=${String(localExpiresAt)}, ceiling=${String(now + ADOPT_MAX_FUTURE_MS)})`
      )
      return { adopted: false }
    }
    if (localExpiresAt <= sub.expiresAt) {
      // Race lost — another caller already adopted a state >= ours.
      return { adopted: false }
    }
    await ctx.db.patch('subscriptions', subId, {
      ciphertext,
      nonce,
      expiresAt: localExpiresAt,
      lastRefreshedAt: now,
      // Adopting local clears any stale reloginRequired marker from a
      // prior run of this very sub on a different machine — the local
      // state being newer means the user successfully refreshed somewhere.
      refreshExpiresAt: undefined,
    })
    return { adopted: true }
  },
})

/**
 * Internal mutation used by the refresh action to record `reloginRequired`
 * by clamping refreshExpiresAt to now. Surfaces as an `⚠ relogin` flag in
 * the dashboard / `cvault list` table.
 */
export const markReloginRequired = internalMutation({
  args: {
    subId: v.id('subscriptions'),
    holderToken: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { subId, holderToken }) => {
    const sub = await ctx.db.get('subscriptions', subId)
    if (!sub) return null

    const patch: {
      refreshExpiresAt: number
      refreshLeaseHolder?: undefined
      refreshLeaseUntil?: undefined
    } = { refreshExpiresAt: Date.now() }

    // If the caller holds the lease, drop it as part of the same patch.
    if (holderToken !== undefined && sub.refreshLeaseHolder === holderToken) {
      patch.refreshLeaseHolder = undefined
      patch.refreshLeaseUntil = undefined
    }
    await ctx.db.patch('subscriptions', subId, patch)
    return null
  },
})
