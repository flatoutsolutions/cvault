import { describe, expect, it } from 'vitest'

import { SECOND_IDENTITY, TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'

/**
 * Spec: §4 (schema) + §5 (queries) + §11 (testing) + §12 (security).
 *
 * Contract under test:
 * - listForUser returns the caller's subs only (user isolation)
 * - removed (soft-deleted) subs are excluded
 * - results are sorted by slot ascending (so the UI can render slots stably)
 * - ciphertext + nonce are stripped from the response (defense-in-depth: never
 *   leak encrypted blobs over the public query channel)
 * - unauthenticated callers get an error
 */

describe('subscriptions.queries.listForUser', () => {
  it('throws when the caller is not authenticated', async () => {
    const t = vault()
    await expect(t.query(api.subscriptions.queries.listForUser, {})).rejects.toThrow(/authenticated/i)
  })

  it('returns an empty array when the authenticated user has no subs', async () => {
    const t = vault()
    await seedUser(t)

    const result = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(result).toEqual([])
  })

  it("returns only the caller's subscriptions, not other users'", async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    await t.run(async (ctx) => {
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

    const aliceResult = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(aliceResult).toHaveLength(1)
    expect(aliceResult[0]?.email).toBe('alice-sub@example.com')

    const bobResult = await t.withIdentity(SECOND_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(bobResult).toHaveLength(1)
    expect(bobResult[0]?.email).toBe('bob-sub@example.com')
  })

  it('excludes subscriptions that have been soft-removed', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    await t.run(async (ctx) => {
      await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'live@example.com',
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
        email: 'gone@example.com',
        slot: 2,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
        removedAt: Date.now(),
      })
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(result.map((s) => s.email)).toEqual(['live@example.com'])
  })

  it('returns subs sorted by slot ascending', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    await t.run(async (ctx) => {
      // Insert out of order to confirm the query (not insertion order) sorts.
      for (const slot of [3, 1, 2]) {
        await ctx.db.insert('subscriptions', {
          userId: aliceId,
          email: `slot${slot.toString()}@example.com`,
          slot,
          ciphertext: new ArrayBuffer(8),
          nonce: new ArrayBuffer(12),
          expiresAt: Date.now() + 60_000,
          subscriptionType: 'max',
          rateLimitTier: 'tier1',
          lastRefreshedAt: Date.now(),
        })
      }
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(result.map((s) => s.slot)).toEqual([1, 2, 3])
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

    const [sub] = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
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

    const [sub] = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(sub).toBeDefined()
    // The bug: keyVersion leaked through, failing the returns validator.
    expect(sub).not.toHaveProperty('keyVersion')
    // Defense-in-depth: confirm the existing strips still hold alongside it.
    expect(sub).not.toHaveProperty('ciphertext')
    expect(sub).not.toHaveProperty('nonce')
    // Sanity: metadata that should be exposed is still present.
    expect(sub?.email).toBe('rotated@example.com')
    expect(sub?.slot).toBe(1)
  })
})
