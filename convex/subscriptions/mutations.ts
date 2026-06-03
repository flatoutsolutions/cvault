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

/**
 * Strict actor lookup for shared-vault audit attribution. Returns the
 * caller's `users._id` (resolved from the verified Clerk identity), or
 * throws if the Clerk webhook hasn't yet inserted a row for the caller.
 *
 * Mirrors PR #18's actions-side pattern (`internal.users.actions.getIdByExternalId`
 * + explicit throw) so `softRemove` / `rename` audit rows attribute the
 * action to the ACTOR rather than the row owner. `getCurrentUserOrThrowFromIdentity`
 * is unfit here because its "any user row" fallback (see
 * `convex/utils/users.ts:3-7`) would silently stamp the audit row with
 * the WRONG user when the caller's webhook is still in flight — which
 * is exactly the failure mode shared-vault auditing is meant to catch.
 */
async function resolveActorIdOrThrow(ctx: MutationCtx, externalId: string): Promise<Id<'users'>> {
  const own = await ctx.db
    .query('users')
    .withIndex('byExternalId', (q) => q.eq('externalId', externalId))
    .unique()
  if (!own) {
    throw new ConvexError({
      code: 'USER_NOT_FOUND',
      message: 'No user row for caller. Sign in once to trigger the Clerk webhook, then retry.',
    })
  }
  return own._id
}

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
     * Machine id, supplied by the CLI as an action arg (CVLT-3: replaces
     * clerkSessionId). Falls back to the resolved Clerk session id for
     * legacy callers (dashboard, cron) that pre-date the machine UUID.
     * These will be fully migrated in later CVLT-3 tasks.
     */
    machineId?: string
  }
): Promise<void> {
  await ctx.db.insert('machineActivity', {
    userId: args.userId,
    machineId: args.machineId ?? resolveCallerSession(getIdentity(ctx)),
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
  /**
   * Identifier of the master key version used to encrypt `ciphertext`.
   * Required — the calling action always supplies it from `encrypt()`'s
   * return value. Stored on the row so rotation can target stale rows
   * by version filter.
   */
  keyVersion: string
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
 * stefan@x.com` would NOT_FOUND because the `byEmail` index does
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
 * Dedupe is GLOBAL by email under the shared-vault doctrine
 * (`convex/utils/users.ts:3-7`): every read path (including
 * `softRemove`/`rename`, `getMetaByEmail`, `listAllActiveSubsRaw`) is
 * keyed on the global `byEmail` index, so the write path must match.
 * Pre-fix the lookup was scoped via `byUserAndEmail`, which let two
 * Clerk users add the same Anthropic email and end up with TWO rows
 * for one address — the dashboard rendered duplicates and backups
 * exported them.
 *
 * Cross-user collision policy: when an existing row's `userId` differs
 * from the caller's, KEEP the original `userId`. First claimer wins;
 * subsequent adders rotate ciphertext + label only. This matches the
 * shared-vault doctrine where tokens are shared and ownership is a
 * bookkeeping field that records who first added the credential.
 *
 * Behavior:
 *  - existing live row (any userId) -> rotate ciphertext+nonce in place,
 *    keep slot stable, KEEP original userId
 *  - existing tombstoned row (any userId) -> revive in place under the
 *    original userId, allocate fresh slot, clear removedAt
 *  - no row anywhere -> allocate next free slot for the caller and insert
 *
 * Slot space is per-user. Slot only matters in CLI ergonomics (the
 * shipped binary still references slot numbers); under shared vault the
 * slot column is informational.
 */
async function upsertSub(ctx: MutationCtx, input: UpsertSubInput): Promise<UpsertSubResult> {
  // Canonicalize the incoming email once. Stored emails are lowercase
  // and lookup keys are lowercase so dedupe matches regardless of how
  // Anthropic / Clerk happened to capitalize the same address.
  const email = canonicalEmail(input.email)

  // Global dedupe via `byEmail`. Multiple rows can technically share an
  // email under the historical schema (live vs. tombstoned), so we
  // collect, prefer the live row, and fall back to a tombstoned one for
  // revival. `.unique()` won't work here — a live row + a tombstoned row
  // for the same email is a legitimate shape from earlier soft-delete
  // semantics.
  const matches = await ctx.db
    .query('subscriptions')
    .withIndex('byEmail', (q) => q.eq('email', email))
    .collect()
  // Canary: more than one LIVE row for an email is a schema-invariant
  // violation (the dedupe in this mutation is the only writer that
  // should produce live rows by email, and it never inserts a second
  // when one already exists). Tombstoned + live coexisting is
  // legitimate from soft-delete semantics; only flag when >1 LIVE.
  const liveMatches = matches.filter((r) => r.removedAt === undefined)
  if (liveMatches.length > 1) {
    console.warn(
      `[cvault] upsertSub: more than one LIVE row for email=${email} — schema invariant violated. Inspect manually.`
    )
  }
  const live = liveMatches[0]
  const tombstoned = matches.find((r) => r.removedAt !== undefined)
  const existing = live ?? tombstoned

  const now = Date.now()

  if (existing && existing.removedAt === undefined) {
    // Live row exists. Rotate ciphertext + label in place; keep the
    // original userId (first-claimer ownership) and slot. The caller
    // doesn't get a "created" signal; their write is a refresh.
    await ctx.db.patch('subscriptions', existing._id, {
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      keyVersion: input.keyVersion,
      expiresAt: input.expiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
      subscriptionType: input.subscriptionType,
      rateLimitTier: input.rateLimitTier,
      lastRefreshedAt: now,
      ...(input.label !== undefined ? { label: input.label } : {}),
    })
    return { subId: existing._id, userId: existing.userId, slot: existing.slot, created: false }
  }

  if (existing && existing.removedAt !== undefined) {
    // Reviving a tombstoned row: re-allocate to the lowest free slot
    // for the row's ORIGINAL owner (slot space is per-user) instead of
    // preserving the tombstoned slot. Otherwise removing slots 1+2 then
    // re-adding email-from-slot-2 would silently revive at slot 2 and
    // leave a hole at slot 1 — confusing for users who expect dense
    // slot numbers.
    const reviveSlot = await nextFreeSlotForUser(ctx, existing.userId)
    await ctx.db.patch('subscriptions', existing._id, {
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      keyVersion: input.keyVersion,
      slot: reviveSlot,
      expiresAt: input.expiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
      subscriptionType: input.subscriptionType,
      rateLimitTier: input.rateLimitTier,
      lastRefreshedAt: now,
      removedAt: undefined,
      ...(input.label !== undefined ? { label: input.label } : {}),
    })
    return { subId: existing._id, userId: existing.userId, slot: reviveSlot, created: false }
  }

  // No row anywhere — first claim. Allocate slot for the caller.
  const slot = await nextFreeSlotForUser(ctx, input.userId)

  const subId = await ctx.db.insert('subscriptions', {
    userId: input.userId,
    email,
    slot,
    label: input.label,
    ciphertext: input.ciphertext,
    nonce: input.nonce,
    keyVersion: input.keyVersion,
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
    keyVersion: v.string(),
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
 * mutation with the resulting ciphertext+nonce+keyVersion. We accept
 * `externalId` directly so the action's pre-resolved Clerk subject is
 * the source of truth (no duplicate identity lookup).
 */
export const upsertEncrypted = internalMutation({
  args: {
    externalId: v.string(),
    email: v.string(),
    ciphertext: v.bytes(),
    nonce: v.bytes(),
    keyVersion: v.string(),
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
     * label per machine. Optional — see
     * `machineActivity/schema.ts:machineLabel` for the contract.
     */
    machineLabel: v.optional(v.string()),
    /**
     * Machine id (CVLT-3 PKCE migration). BAPI-minted CLI JWTs lack a
     * `sid` claim; the CLI now sends its persistent machine UUID instead.
     * Optional for backward compat with older callers.
     */
    machineId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { email, machineLabel, machineId }) => {
    // SHARED-VAULT (`convex/utils/users.ts:3-7`): any authenticated
    // allowed-domain caller resolves any row regardless of nominal owner.
    // Reads, public mutations (this), AND the write-dedupe in
    // `upsertSub` all use the global `byEmail` index now (the audit-fix
    // closed the only remaining scoped path).
    //
    // Email is canonicalized to lowercase to match the storage convention
    // set in `upsertSub`. Without this, `cvault remove Stefan@x.com`
    // when the row was stored as `stefan@x.com` would NOT_FOUND.
    //
    // FCFS by `_creationTime` if there were multiple rows for one email
    // — but there shouldn't be: writes canonicalize + lowercase, and
    // `upsertSub` dedupes on `(userId, email)` so at worst there is one
    // row per user per email.
    const matches = await ctx.db
      .query('subscriptions')
      .withIndex('byEmail', (q) => q.eq('email', canonicalEmail(email)))
      .collect()
    const sub = matches.find((s) => s.removedAt === undefined)
    if (!sub) {
      throw new ConvexError({ code: 'NOT_FOUND', message: `No subscription matching: ${email}` })
    }

    // Audit `userId` records the ACTOR (caller's `users._id`), NOT
    // `sub.userId` (row owner). Same decision as PR #18 in actions.ts:
    // attributing a cross-user remove to the row owner would falsely log
    // who did what under shared vault. Strict resolution — no fallback
    // to "any user row" — so the audit is correct or we throw with a
    // clear "sign in once" message.
    const actorUserId = await resolveActorIdOrThrow(ctx, getIdentity(ctx).subject)

    await ctx.db.patch('subscriptions', sub._id, { removedAt: Date.now() })
    await recordActivity(ctx, {
      userId: actorUserId,
      action: 'remove',
      subscriptionId: sub._id,
      ...(machineLabel !== undefined ? { machineLabel } : {}),
      ...(machineId !== undefined ? { machineId } : {}),
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
    machineId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { email, label, machineLabel, machineId }) => {
    // Shared-vault lookup + actor attribution rules mirror `softRemove`.
    // See its docstring for the full rationale.
    const matches = await ctx.db
      .query('subscriptions')
      .withIndex('byEmail', (q) => q.eq('email', canonicalEmail(email)))
      .collect()
    const sub = matches.find((s) => s.removedAt === undefined)
    if (!sub) {
      throw new ConvexError({ code: 'NOT_FOUND', message: `No subscription matching: ${email}` })
    }

    const actorUserId = await resolveActorIdOrThrow(ctx, getIdentity(ctx).subject)

    await ctx.db.patch('subscriptions', sub._id, { label })
    await recordActivity(ctx, {
      userId: actorUserId,
      action: 'rename',
      subscriptionId: sub._id,
      ...(machineLabel !== undefined ? { machineLabel } : {}),
      ...(machineId !== undefined ? { machineId } : {}),
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
    /**
     * Key version under which `ciphertext` was just encrypted. Required
     * for the rotation race fix (A1 in 2026-05-04 review): a
     * concurrently-running rotation could have already advanced the
     * row's `keyVersion`; without writing the encrypter's `keyVersion`
     * here, the row would carry the rotation's label but the older
     * ciphertext, and decrypt would AES-GCM-fail forever.
     */
    keyVersion: v.string(),
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
      keyVersion: args.keyVersion,
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
 * pull-on-use proactive-refresh check (`expiresAt < now + 5min`) would
 * never fire and the row would be poisoned indefinitely. Anthropic's
 * access-token lifetime is 8h; 24h is a generous bound for clock skew.
 * Any incoming `localExpiresAt` past `Date.now() + 24h` is rejected
 * (return `adopted: false`, log a warning with redacted state).
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
    /**
     * Key version under which `ciphertext` was just encrypted. Required
     * for the rotation race fix (A1 in 2026-05-04 review): see
     * `commitRefreshedTokens` for the full rationale.
     */
    keyVersion: v.string(),
    localExpiresAt: v.number(),
  },
  returns: v.object({ adopted: v.boolean() }),
  handler: async (ctx, { subId, ciphertext, nonce, keyVersion, localExpiresAt }) => {
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
      keyVersion,
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

/**
 * Patch a single row with re-wrapped ciphertext + new keyVersion. Used
 * exclusively by the `rotateAllSubscriptions` internal action.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §5.
 */
export const patchRotatedRow = internalMutation({
  args: {
    subId: v.id('subscriptions'),
    ciphertext: v.bytes(),
    nonce: v.bytes(),
    keyVersion: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { subId, ciphertext, nonce, keyVersion }) => {
    const sub = await ctx.db.get('subscriptions', subId)
    if (!sub) return null
    // CAS-style guard: do nothing if the row is already on the target
    // version (idempotent re-runs / parallel rotation jobs).
    if (sub.keyVersion === keyVersion) return null
    await ctx.db.patch('subscriptions', subId, { ciphertext, nonce, keyVersion })
    return null
  },
})
