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
 * Behaviors covered:
 *  - throws when caller is not authenticated
 *  - throws NOT_FOUND when slot doesn't match a sub the caller owns
 *  - returns the sub meta + last 3 refresh log entries (newest first)
 *  - returns empty refreshLog when no entries exist yet
 *  - returns the most recent machineActivity row for the sub
 *  - never returns ciphertext / nonce
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
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

  it('throws NOT_FOUND when slot does not match a sub the caller owns', async () => {
    const t = vault()
    await seedSub(t)
    await expect(
      t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.getStatus, { slot: 99 })
    ).rejects.toThrow(/not.*found|no subscription/i)
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

    // Either undefined (omitted from validator) or null is fine — what
    // matters is the field signals "no activity yet" so the CLI can omit
    // the hint section.
    expect(status.lastMachineActivity ?? null).toBeNull()
  })

  // M4 regression: a high-churn sub A's activity rows must not push sub B's
  // most recent row out of the lookup window. The previous implementation
  // took the user's 50 most-recent rows and then filtered to subId — for
  // a heavy sub A, sub B's recent activity could fall outside the take(50)
  // window and silently appear as null. The fix is a composite
  // (subscriptionId, at) index used directly.
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

    // Seed an OLD machineActivity row for sub B and 100 NEW rows for sub A.
    // With the old `take(50).find(...)` approach, sub B's row would be
    // pushed out of the 50-row window. The composite index lookup must
    // still find it.
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

    // Sub B's old row MUST be found — even with 100 newer sub A rows
    // crowding the user's recent-activity timeline.
    expect(status.lastMachineActivity).not.toBeNull()
    expect(status.lastMachineActivity?.action).toBe('switch')
    expect(status.lastMachineActivity?.clerkSessionId).toBe('sess_B_old')
  })
})
