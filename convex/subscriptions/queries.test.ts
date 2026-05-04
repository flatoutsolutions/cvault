import { describe, expect, it } from 'vitest'

import { SECOND_IDENTITY, TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'

/**
 * Spec: §4 (schema) + §5 (queries) + §11 (testing) + §12 (security).
 *
 * Architectural intent: cvault is a shared vault. Per
 * `convex/utils/users.ts:3-7`:
 *
 *   "Any authenticated Clerk identity (= you) reads/writes the same vault
 *    can read/write any row."
 *
 * That means read queries MUST NOT scope by `userId`. The contract under
 * test:
 *  - `list` returns every non-removed sub regardless of which user wrote
 *    it, sorted by `_creationTime` ASC (first-come-first-serve).
 *  - `getMetaByEmail` looks up by email globally; any authed caller can
 *    resolve any sub.
 *  - Soft-removed subs are excluded.
 *  - Ciphertext / nonce / keyVersion are stripped from every wire shape.
 *  - Unauthenticated callers are rejected.
 *  - `listForUser` is preserved as a thin alias for `list` so the prod CLI
 *    0.1.6 binary keeps working until the next major bump.
 */

describe('subscriptions.queries.list', () => {
  it('throws when the caller is not authenticated', async () => {
    const t = vault()
    await expect(t.query(api.subscriptions.queries.list, {})).rejects.toThrow(/authenticated/i)
  })

  it('returns an empty array when the vault has no subs', async () => {
    const t = vault()
    await seedUser(t)

    const result = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.list, {})
    expect(result).toEqual([])
  })

  it('returns subs across all users — shared vault visibility', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    await t.run(async (ctx) => {
      // Inserted in this order so `_creationTime` ASC = [alice, bob].
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'alice-sub@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
      await ctx.db.insert('subscriptions', {
        userId: bobId,
        email: 'bob-sub@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    const aliceResult = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.list, {})
    const bobResult = await t.withIdentity(SECOND_IDENTITY).query(api.subscriptions.queries.list, {})

    // Both users see the same set.
    expect(aliceResult.map((s) => s.email)).toEqual(['alice-sub@example.com', 'bob-sub@example.com'])
    expect(bobResult.map((s) => s.email)).toEqual(['alice-sub@example.com', 'bob-sub@example.com'])
  })

  it('excludes soft-removed subs across users', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    await t.run(async (ctx) => {
      // Alice: 1 live + 1 removed. Bob: 1 live. Carol: nothing.
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'alice-live@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'alice-gone@example.com',
        slot: 2,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
        removedAt: Date.now(),
      })
      await ctx.db.insert('subscriptions', {
        userId: bobId,
        email: 'bob-live@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.list, {})
    expect(result.map((s) => s.email)).toEqual(['alice-live@example.com', 'bob-live@example.com'])
  })

  it('returns subs sorted by _creationTime ASC (first-come-first-serve)', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    await t.run(async (ctx) => {
      // Insert order = creation order. Bob's sub lands in the middle to
      // exercise the cross-user sort path.
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'first@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
      await ctx.db.insert('subscriptions', {
        userId: bobId,
        email: 'second@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'third@example.com',
        slot: 2,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.list, {})
    expect(result.map((s) => s.email)).toEqual(['first@example.com', 'second@example.com', 'third@example.com'])
  })

  it('strips ciphertext and nonce from the response payload', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    await t.run(async (ctx) => {
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'a@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    const [sub] = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.list, {})
    expect(sub).toBeDefined()
    expect(sub).not.toHaveProperty('ciphertext')
    expect(sub).not.toHaveProperty('nonce')
    // But other metadata should remain.
    expect(sub?.email).toBe('a@example.com')
    expect(sub?.slot).toBe(1)
    expect(sub?.subscriptionType).toBe('max')
  })

  it('strips keyVersion from the response payload (server-only encryption metadata)', async () => {
    // Regression guard for the prod incident triggered by PR #10:
    // `keyVersion` was added to the schema and started being persisted on
    // every mutation, but `toMeta()` did not strip it. The returns
    // validator rejected the leaked field with `ReturnsValidationError`,
    // taking listForUser / getMetaByEmail / getStatus down for any sub
    // written or refreshed since the rotation feature shipped.
    const t = vault()
    const aliceId = await seedUser(t)

    await t.run(async (ctx) => {
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'rotated@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        keyVersion: 'v1',
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    const [sub] = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.list, {})
    expect(sub).toBeDefined()
    expect(sub).not.toHaveProperty('keyVersion')
    expect(sub).not.toHaveProperty('ciphertext')
    expect(sub).not.toHaveProperty('nonce')
    expect(sub?.email).toBe('rotated@example.com')
    expect(sub?.slot).toBe(1)
  })
})

describe('subscriptions.queries.listForUser (legacy alias)', () => {
  // The shipped CLI 0.1.6 binary still calls `listForUser`. Keep the
  // alias until the next CLI major so homebrew users on 0.1.5 / 0.1.6
  // don't break.
  it('mirrors `list` exactly — same shape, same cross-user visibility', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    await t.run(async (ctx) => {
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'alice@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
      await ctx.db.insert('subscriptions', {
        userId: bobId,
        email: 'bob@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    const aliasResult = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    const newResult = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.list, {})

    expect(aliasResult.map((s) => s.email)).toEqual(['alice@example.com', 'bob@example.com'])
    expect(aliasResult).toEqual(newResult)
  })
})

describe('subscriptions.queries.getMetaByEmail', () => {
  it('throws when the caller is not authenticated', async () => {
    const t = vault()
    await expect(t.query(api.subscriptions.queries.getMetaByEmail, { email: 'x@y.com' })).rejects.toThrow(
      /authenticated/i
    )
  })

  it('returns null when no sub matches the email anywhere in the vault', async () => {
    const t = vault()
    await seedUser(t)

    const result = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getMetaByEmail, {
      email: 'nobody@example.com',
    })
    expect(result).toBeNull()
  })

  it('resolves a sub written by another user — shared vault visibility', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    await t.run(async (ctx) => {
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'alice@flatout.solutions',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
      await ctx.db.insert('subscriptions', {
        userId: bobId,
        email: 'bob@flatout.solutions',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    // Alice looks up Bob's sub — this MUST resolve in shared mode.
    const fromAlice = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getMetaByEmail, {
      email: 'bob@flatout.solutions',
    })
    expect(fromAlice).not.toBeNull()
    expect(fromAlice?.email).toBe('bob@flatout.solutions')

    // Bob looks up the same row — same result.
    const fromBob = await t.withIdentity(SECOND_IDENTITY).query(api.subscriptions.queries.getMetaByEmail, {
      email: 'bob@flatout.solutions',
    })
    expect(fromBob?.email).toBe('bob@flatout.solutions')
  })

  it('lowercases the email lookup key (matches storage canonicalization)', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    await t.run(async (ctx) => {
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'casey@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getMetaByEmail, {
      email: 'Casey@example.com',
    })
    expect(result?.email).toBe('casey@example.com')
  })

  it('skips removed rows and resolves the first live row instead', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    await t.run(async (ctx) => {
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'reused@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
        removedAt: Date.now(),
      })
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'reused@example.com',
        slot: 2,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getMetaByEmail, {
      email: 'reused@example.com',
    })
    expect(result).not.toBeNull()
    expect(result?.slot).toBe(2)
  })
})
