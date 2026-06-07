/**
 * Shared-vault contract for the two internal lookup queries used by the
 * authenticated `pullForSwitch` / `requestRefresh` actions.
 *
 * Spec: `convex/utils/users.ts:3-7` — any authenticated allowed-domain
 * identity reads/writes any row. The previous queries
 * (`getSubscriptionForActor` + `getSubscriptionByIdForActor`) scoped the
 * read to the caller's `users._id`, which contradicted the shared-vault
 * design and caused `cvault sync --all` to fail with NOT_FOUND when the
 * acting machine's owner differed from the sub's owner.
 *
 * These tests pin the new contract:
 *   1. The queries take NO `externalId` arg — internal queries inherit
 *      auth from the calling action wrapper, which is the only access
 *      gate that still applies under shared-vault.
 *   2. The lookups resolve globally:
 *        - email branch via the `byEmail` index (lowercase canonicalized)
 *        - slot branch via `_creationTime` FCFS scan
 *        - by-id branch via `ctx.db.get`
 *      Filtered to rows with `removedAt === undefined`.
 *
 * Regression guard: PR #15/#16/#17 unscoped the dashboard read paths;
 * the audit that left the action's runQuery layer scoped was wrong.
 */
import { describe, expect, it } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'

interface SeedSubArgs {
  userId: Id<'users'>
  email: string
  slot: number
  removedAt?: number
}

async function seedSubscription(t: ReturnType<typeof vault>, args: SeedSubArgs): Promise<Id<'subscriptions'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('subscriptions', {
      userId: args.userId,
      email: args.email,
      slot: args.slot,
      ciphertext: new ArrayBuffer(8),
      nonce: new ArrayBuffer(12),
      expiresAt: Date.now() + 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
      lastRefreshedAt: Date.now(),
      ...(args.removedAt !== undefined ? { removedAt: args.removedAt } : {}),
    })
  })
}

async function seedTwoUsers(t: ReturnType<typeof vault>) {
  // Alice corresponds to TEST_IDENTITY (any test that exercises
  // authenticated wrappers will resolve to her). Bob is a co-tenant in
  // the shared vault.
  return await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert('users', {
      externalId: TEST_IDENTITY.subject,
      name: TEST_IDENTITY.name,
      primaryEmail: TEST_IDENTITY.email,
      otherEmails: [],
    })
    const bobId = await ctx.db.insert('users', {
      externalId: 'user_test_bob',
      name: 'Bob Tester',
      primaryEmail: 'bob@flatout.solutions',
      otherEmails: [],
    })
    return { aliceId, bobId }
  })
}

describe('subscriptions.internalReads.getSubscriptionBySlotOrEmail (shared vault)', () => {
  it('resolves a sub by email regardless of which user owns it', async () => {
    const t = vault()
    const { aliceId, bobId } = await seedTwoUsers(t)
    // Alice owns one sub; bob owns another. The internal query must be
    // able to find bob's sub even when no `externalId` is passed.
    void aliceId
    const bobSubId = await seedSubscription(t, {
      userId: bobId,
      email: 'bob-slot-1@flatout.solutions',
      slot: 1,
    })

    const result = await t.query(internal.subscriptions.internalReads.getSubscriptionBySlotOrEmail, {
      slotOrEmail: 'bob-slot-1@flatout.solutions',
    })

    expect(result).not.toBeNull()
    expect(result?._id).toEqual(bobSubId)
  })

  it('lowercases the email lookup to match canonical storage', async () => {
    const t = vault()
    const { bobId } = await seedTwoUsers(t)
    const bobSubId = await seedSubscription(t, {
      userId: bobId,
      email: 'mixed-case@flatout.solutions',
      slot: 2,
    })

    const result = await t.query(internal.subscriptions.internalReads.getSubscriptionBySlotOrEmail, {
      slotOrEmail: 'Mixed-Case@FlatOut.Solutions',
    })

    expect(result).not.toBeNull()
    expect(result?._id).toEqual(bobSubId)
  })

  it('skips soft-removed rows when resolving by email', async () => {
    const t = vault()
    const { bobId } = await seedTwoUsers(t)
    // First seed a tombstoned row, then a live row at the same email so
    // we can prove the live one wins regardless of insert order.
    await seedSubscription(t, {
      userId: bobId,
      email: 'recycle@flatout.solutions',
      slot: 3,
      removedAt: Date.now() - 1000,
    })
    const liveSubId = await seedSubscription(t, {
      userId: bobId,
      email: 'recycle@flatout.solutions',
      slot: 3,
    })

    const result = await t.query(internal.subscriptions.internalReads.getSubscriptionBySlotOrEmail, {
      slotOrEmail: 'recycle@flatout.solutions',
    })

    expect(result?._id).toEqual(liveSubId)
  })

  /**
   * Slot lookups under shared-vault are NOT a match against the stored
   * `slot` column — that field is per-user and ambiguous globally (two
   * users' first subs both have stored `slot=1`). The lookup interprets
   * the input as a FCFS RANK ORDINAL on the global active table:
   *   `1` = oldest non-removed sub by `_creationTime`
   *   `2` = second-oldest, …
   *
   * The user's design ("locally any number, on the web FCFS") locks this
   * down. The legacy stored-slot column is retained on the row only so
   * shipped CLIs that print it in `cvault list` keep working.
   *
   * This trio of tests pins the rank-ordinal semantics: rank 1 returns
   * the oldest, rank 2 returns the second, rank 3 (out of bounds with
   * only two seeded rows) returns null.
   */
  it('rank 1 returns the oldest live sub (FCFS rank ordinal, not stored-slot match)', async () => {
    const t = vault()
    const { aliceId, bobId } = await seedTwoUsers(t)
    // Alice's sub at stored slot 1 is inserted first; bob's also has
    // stored slot 1 (per-user numbering colliding globally).
    const firstSubId = await seedSubscription(t, {
      userId: aliceId,
      email: 'alice-1@flatout.solutions',
      slot: 1,
    })
    await seedSubscription(t, {
      userId: bobId,
      email: 'bob-1@flatout.solutions',
      slot: 1,
    })

    const result = await t.query(internal.subscriptions.internalReads.getSubscriptionBySlotOrEmail, {
      slotOrEmail: '1',
    })

    expect(result?._id).toEqual(firstSubId)
  })

  it('rank 2 returns the second-oldest live sub (regression: pre-fix returned null because no row had stored slot=2)', async () => {
    const t = vault()
    const { aliceId, bobId } = await seedTwoUsers(t)
    // Both seeded subs have stored slot=1. Pre-fix lookup matched
    // `r.slot === 2` → null (the bug behind `cvault switch 2` 404s).
    // Under FCFS rank-ordinal: rank 2 = second-oldest = bob's row.
    await seedSubscription(t, {
      userId: aliceId,
      email: 'alice-1@flatout.solutions',
      slot: 1,
    })
    const secondSubId = await seedSubscription(t, {
      userId: bobId,
      email: 'bob-1@flatout.solutions',
      slot: 1,
    })

    const result = await t.query(internal.subscriptions.internalReads.getSubscriptionBySlotOrEmail, {
      slotOrEmail: '2',
    })

    expect(result?._id).toEqual(secondSubId)
  })

  it('rank N+1 returns null when only N live subs exist', async () => {
    const t = vault()
    const { aliceId, bobId } = await seedTwoUsers(t)
    await seedSubscription(t, { userId: aliceId, email: 'alice-1@flatout.solutions', slot: 1 })
    await seedSubscription(t, { userId: bobId, email: 'bob-1@flatout.solutions', slot: 1 })

    const result = await t.query(internal.subscriptions.internalReads.getSubscriptionBySlotOrEmail, {
      slotOrEmail: '3',
    })

    expect(result).toBeNull()
  })

  it('rank skips soft-removed rows when ranking by creation time', async () => {
    const t = vault()
    const { aliceId, bobId } = await seedTwoUsers(t)
    // Alice's row is the OLDEST but soft-removed → must NOT count for ranking.
    await seedSubscription(t, {
      userId: aliceId,
      email: 'tombstone@flatout.solutions',
      slot: 1,
      removedAt: Date.now() - 1000,
    })
    const liveSubId = await seedSubscription(t, {
      userId: bobId,
      email: 'live@flatout.solutions',
      slot: 1,
    })

    const result = await t.query(internal.subscriptions.internalReads.getSubscriptionBySlotOrEmail, {
      slotOrEmail: '1',
    })

    // Without the live-only filter on the rank, the tombstoned row would
    // claim rank 1 and bob's live row would slip to rank 2 — exactly the
    // off-by-one drift that breaks `cvault switch 1` after a `cvault remove`.
    expect(result?._id).toEqual(liveSubId)
  })

  it('returns null when neither slot nor email matches', async () => {
    const t = vault()
    await seedTwoUsers(t)

    const result = await t.query(internal.subscriptions.internalReads.getSubscriptionBySlotOrEmail, {
      slotOrEmail: 'no-such@flatout.solutions',
    })

    expect(result).toBeNull()
  })
})

describe('subscriptions.internalReads.getSubscriptionById (shared vault)', () => {
  it('resolves any sub by id regardless of owner', async () => {
    const t = vault()
    const { bobId } = await seedTwoUsers(t)
    const bobSubId = await seedSubscription(t, {
      userId: bobId,
      email: 'bob-byid@flatout.solutions',
      slot: 4,
    })

    const result = await t.query(internal.subscriptions.internalReads.getSubscriptionById, {
      subId: bobSubId,
    })

    expect(result).not.toBeNull()
    expect(result?._id).toEqual(bobSubId)
  })

  it('returns null for a soft-removed sub', async () => {
    const t = vault()
    const { bobId } = await seedTwoUsers(t)
    const removedSubId = await seedSubscription(t, {
      userId: bobId,
      email: 'gone@flatout.solutions',
      slot: 5,
      removedAt: Date.now() - 1000,
    })

    const result = await t.query(internal.subscriptions.internalReads.getSubscriptionById, {
      subId: removedSubId,
    })

    expect(result).toBeNull()
  })
})
