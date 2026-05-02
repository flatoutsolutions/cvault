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
import { getCurrentUserOrThrowFromIdentity } from '../utils/users'

/**
 * Read the Clerk session id from the JWT identity, returning a sentinel
 * when the `sid` claim is missing. The audit-row insert requires a
 * non-empty string so we keep the row writable even on identities
 * without sid (e.g. internal callers that hand-built an identity for
 * tests). Spec §4 + §12 want every authenticated state-changing
 * operation to leave a `machineActivity` row.
 */
function clerkSessionFromIdentity(ctx: MutationCtx): string {
  const identity = getIdentity(ctx)
  const sid = (identity as { sid?: unknown }).sid
  return typeof sid === 'string' && sid.length > 0 ? sid : 'unknown-session'
}

type ActivityAction = 'switch' | 'add' | 'pull' | 'remove' | 'refresh' | 'rename'

/**
 * Insert a `machineActivity` row directly via `ctx.db.insert` (rather
 * than via the `internal.machineActivity.mutations.record` ipHash mutation)
 * because (a) we never have a raw IP at the public-mutation entry — they
 * arrive over the WebSocket — and (b) staying inside the mutation lets
 * the activity-row insert participate in the same transaction as the
 * subscription mutation, so a failure post-insert atomically rolls back.
 */
async function recordActivity(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    action: ActivityAction
    subscriptionId?: Id<'subscriptions'>
  }
): Promise<void> {
  await ctx.db.insert('machineActivity', {
    userId: args.userId,
    clerkSessionId: clerkSessionFromIdentity(ctx),
    action: args.action,
    subscriptionId: args.subscriptionId,
    at: Date.now(),
    // No ipHash here — see helper docstring.
  })
}

/**
 * Allocate the next free slot for a user. Slots are 1-indexed and we
 * fill the lowest gap so removed-then-readded subs stay compact.
 */
function nextFreeSlot(rows: Array<Doc<'subscriptions'>>): number {
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
  // Dedupe by email only.
  const matches = await ctx.db
    .query('subscriptions')
    .filter((q) => q.eq(q.field('email'), input.email))
    .collect()
  const existing = matches[0] ?? null

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
    await ctx.db.patch('subscriptions', existing._id, {
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      expiresAt: input.expiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
      subscriptionType: input.subscriptionType,
      rateLimitTier: input.rateLimitTier,
      lastRefreshedAt: now,
      removedAt: undefined,
      ...(input.label !== undefined ? { label: input.label } : {}),
    })
    return { subId: existing._id, userId: input.userId, slot: existing.slot, created: false }
  }

  // Slot space is global across all subs.
  const allSubs = await ctx.db.query('subscriptions').collect()
  const slot = nextFreeSlot(allSubs)

  const subId = await ctx.db.insert('subscriptions', {
    userId: input.userId,
    email: input.email,
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
  args: { email: v.string() },
  returns: v.null(),
  handler: async (ctx, { email }) => {
    const user = await getCurrentUserOrThrowFromIdentity(ctx, getIdentity(ctx).subject)

    const matches = await ctx.db
      .query('subscriptions')
      .filter((q) => q.eq(q.field('email'), email))
      .collect()
    const sub = matches.find((s) => s.removedAt === undefined)

    if (!sub) {
      throw new ConvexError({ code: 'NOT_FOUND', message: `Subscription not found for email: ${email}` })
    }

    await ctx.db.patch('subscriptions', sub._id, { removedAt: Date.now() })
    await recordActivity(ctx, { userId: user._id, action: 'remove', subscriptionId: sub._id })
    return null
  },
})

export const rename = authenticatedMutation({
  args: { email: v.string(), label: v.string() },
  returns: v.null(),
  handler: async (ctx, { email, label }) => {
    const user = await getCurrentUserOrThrowFromIdentity(ctx, getIdentity(ctx).subject)

    const matches = await ctx.db
      .query('subscriptions')
      .filter((q) => q.eq(q.field('email'), email))
      .collect()
    const sub = matches.find((s) => s.removedAt === undefined)

    if (!sub) {
      throw new ConvexError({ code: 'NOT_FOUND', message: `Subscription not found for email: ${email}` })
    }

    await ctx.db.patch('subscriptions', sub._id, { label })
    await recordActivity(ctx, { userId: user._id, action: 'rename', subscriptionId: sub._id })
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
    usage5h: v.optional(
      v.object({ pct: v.number(), resetsAt: v.number(), fetchedAt: v.number() })
    ),
    usage7d: v.optional(
      v.object({ pct: v.number(), resetsAt: v.number(), fetchedAt: v.number() })
    ),
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
