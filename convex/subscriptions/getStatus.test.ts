/**
 * Spec: §5 / §8 — `subscriptions.queries.getStatus`.
 *
 * Lightweight, read-only diagnostic query backing the `cvault status`
 * CLI command. Returns the per-sub metadata callers need to compare
 * local Keychain state against the vault, plus the last few refresh log
 * entries and the most recent machineActivity row, so the CLI can
 * render an actionable hint (e.g. "Last machineActivity: switch on
 * macbook-2, 3 hours ago").
 *
 * Architectural intent — shared vault. Per `convex/utils/users.ts:3-7`,
 * any authenticated identity reads any sub. `getStatus` therefore takes
 * either:
 *   - `{ subId }` — the precise way; works across users.
 *   - `{ slot }`  — legacy, ambiguous in shared mode (multiple users may
 *                   have the same slot number). Disambiguates by lowest
 *                   `_creationTime` (first-come-first-serve). Documented
 *                   for the shipped CLI 0.1.6 binary; new clients should
 *                   pass `subId`.
 *
 * Behaviors covered:
 *  - throws when caller is not authenticated
 *  - subId mode: returns the sub for any caller (cross-user)
 *  - subId mode: throws NOT_FOUND when the sub does not exist or is removed
 *  - slot mode: returns the row with the lowest `_creationTime` when
 *    multiple users have a row at that slot (FCFS disambiguation)
 *  - slot mode: throws NOT_FOUND when no live row exists at that slot
 *  - returns the sub meta + last 3 refresh log entries (newest first)
 *  - returns empty refreshLog when no entries exist yet
 *  - returns the most recent machineActivity row for the sub
 *  - never returns ciphertext / nonce
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SECOND_IDENTITY, TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import { encrypt } from './crypto'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 21).toString('base64')
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.VAULT_AES_KEY
  } else {
    process.env.VAULT_AES_KEY = ORIGINAL_KEY
  }
})

async function seedSub(t: ReturnType<typeof vault>) {
  await seedUser(t)
  const plaintext = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-STATUS-AAAAAAAAAAAAAAAAAAAA',
      refreshToken: 'sk-ant-ort01-STATUS-BBBBBBBBBBBBBBBBBBBB',
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ['user:inference'],
    },
  })
  const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
  return await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
    email: 'status@example.com',
    ciphertext,
    nonce,
    keyVersion,
    expiresAt: Date.now() + 60 * 60 * 1000,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
  })
}

describe('subscriptions.queries.getStatus', () => {
  it('throws when caller is not authenticated', async () => {
    const t = vault()
    await expect(t.query(api.subscriptions.queries.getStatus, { slot: 1 })).rejects.toThrow(/authenticated/i)
  })

  it('throws NOT_FOUND when slot does not match any live sub anywhere in the vault', async () => {
    const t = vault()
    await seedSub(t)
    await expect(
      t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getStatus, { slot: 99 })
    ).rejects.toThrow(/not.*found|no subscription/i)
  })

  it("subId mode: cross-user lookup — alice can read bob's sub", async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    const bobSubId = await t.run(async (ctx) => {
      return await ctx.db.insert('subscriptions', {
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
    void aliceId

    const status = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getStatus, { subId: bobSubId })
    expect(status.sub.email).toBe('bob@example.com')
    expect(status.sub._id).toBe(bobSubId)
  })

  it('subId mode: throws NOT_FOUND when the sub is soft-removed', async () => {
    const t = vault()
    const aliceId = await seedUser(t)

    const subId = await t.run(async (ctx) => {
      return await ctx.db.insert('subscriptions', {
        userId: aliceId,
        email: 'gone@example.com',
        slot: 1,
        ciphertext: new ArrayBuffer(8),
        nonce: new ArrayBuffer(12),
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
        removedAt: Date.now(),
      })
    })

    await expect(t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getStatus, { subId })).rejects.toThrow(
      /not.*found|no subscription/i
    )
  })

  it('slot mode: returns the lowest-_creationTime row when multiple users have rows at the same slot (FCFS)', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    // Insert order = creation order. Both at slot 1 — FCFS picks alice.
    const aliceSubId = await t.run(async (ctx) => {
      return await ctx.db.insert('subscriptions', {
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
    })
    await t.run(async (ctx) => {
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

    const status = await t.withIdentity(SECOND_IDENTITY).query(api.subscriptions.queries.getStatus, { slot: 1 })
    expect(status.sub._id).toBe(aliceSubId)
    expect(status.sub.email).toBe('alice@example.com')
  })

  it('returns sub meta with no refreshLog when none exists', async () => {
    const t = vault()
    const inserted = await seedSub(t)

    const status = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getStatus, {
      slot: inserted.slot,
    })

    expect(status.sub.email).toBe('status@example.com')
    expect(status.sub.slot).toBe(inserted.slot)
    expect(status.refreshLog).toEqual([])
    // Defense-in-depth: queries must NEVER ship ciphertext/nonce.
    const subKeys = Object.keys(status.sub)
    expect(subKeys).not.toContain('ciphertext')
    expect(subKeys).not.toContain('nonce')
  })

  it('returns the last 3 refreshLog entries newest first', async () => {
    const t = vault()
    const inserted = await seedSub(t)

    // Seed 5 refreshLog rows with increasing `at` so we can verify both
    // the order (newest first) and the cap at 3.
    await t.run(async (ctx) => {
      const baseAt = Date.now() - 5 * 60 * 1000
      for (let i = 0; i < 5; i += 1) {
        await ctx.db.insert('refreshLog', {
          userId: inserted.userId,
          subscriptionId: inserted.subId,
          triggeredBy: 'cron',
          outcome: i === 4 ? 'failure' : 'success',
          at: baseAt + i * 60 * 1000,
        })
      }
    })

    const status = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getStatus, {
      slot: inserted.slot,
    })

    expect(status.refreshLog).toHaveLength(3)
    // Newest first: the most-recent `at` (baseAt + 4*60s) at index 0.
    const firstAt = status.refreshLog[0]?.at ?? 0
    const secondAt = status.refreshLog[1]?.at ?? 0
    const thirdAt = status.refreshLog[2]?.at ?? 0
    expect(firstAt).toBeGreaterThan(secondAt)
    expect(secondAt).toBeGreaterThan(thirdAt)
    expect(status.refreshLog[0]?.outcome).toBe('failure')
  })

  it('returns the most recent machineActivity row for the sub', async () => {
    const t = vault()
    const inserted = await seedSub(t)

    // Seed two machineActivity rows: an old `add` and a recent `switch`.
    await t.run(async (ctx) => {
      await ctx.db.insert('machineActivity', {
        userId: inserted.userId,
        clerkSessionId: 'sess_old',
        action: 'add',
        subscriptionId: inserted.subId,
        at: Date.now() - 24 * 60 * 60 * 1000,
      })
      await ctx.db.insert('machineActivity', {
        userId: inserted.userId,
        clerkSessionId: 'sess_new',
        action: 'switch',
        subscriptionId: inserted.subId,
        at: Date.now() - 5 * 60 * 1000,
      })
    })

    const status = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getStatus, {
      slot: inserted.slot,
    })

    expect(status.lastMachineActivity).toBeDefined()
    expect(status.lastMachineActivity?.action).toBe('switch')
    expect(status.lastMachineActivity?.clerkSessionId).toBe('sess_new')
  })

  it('returns lastMachineActivity as null when no rows exist for the sub', async () => {
    const t = vault()
    const inserted = await seedSub(t)

    const status = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getStatus, {
      slot: inserted.slot,
    })

    expect(status.lastMachineActivity ?? null).toBeNull()
  })

  // M4 regression: a high-churn sub A's activity rows must not push sub B's
  // most recent row out of the lookup window.
  it("M4: finds sub B's most recent activity even when sub A has 100+ recent rows", async () => {
    const t = vault()
    const subA = await seedSub(t)

    // Seed sub B (different email so it gets a different slot).
    const plaintextB = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-B-AAAAAAAAAAAAAAAAAAAA',
        refreshToken: 'sk-ant-ort01-B-BBBBBBBBBBBBBBBBBBBB',
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: ['user:inference'],
      },
    })
    const { ciphertext: ctB, nonce: nonceB, keyVersion: ctBKV } = encrypt(plaintextB)
    const subB = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'subB@example.com',
      ciphertext: ctB,
      nonce: nonceB,
      keyVersion: ctBKV,
      expiresAt: Date.now() + 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    await t.run(async (ctx) => {
      const subBAt = Date.now() - 24 * 60 * 60 * 1000
      await ctx.db.insert('machineActivity', {
        userId: subB.userId,
        clerkSessionId: 'sess_B_old',
        action: 'switch',
        subscriptionId: subB.subId,
        at: subBAt,
      })
      // 100 newer rows for sub A.
      for (let i = 0; i < 100; i += 1) {
        await ctx.db.insert('machineActivity', {
          userId: subA.userId,
          clerkSessionId: `sess_A_${i.toString()}`,
          action: 'pull',
          subscriptionId: subA.subId,
          at: Date.now() - 60 * 1000 + i,
        })
      }
    })

    const status = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getStatus, {
      slot: subB.slot,
    })

    expect(status.lastMachineActivity).not.toBeNull()
    expect(status.lastMachineActivity?.action).toBe('switch')
    expect(status.lastMachineActivity?.clerkSessionId).toBe('sess_B_old')
  })
})
