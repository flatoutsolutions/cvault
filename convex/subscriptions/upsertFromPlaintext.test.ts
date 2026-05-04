/**
 * Spec: §5 (`upsert({email, plaintextBlob, slot?})`).
 *
 * `subscriptions.actions.upsertFromPlaintext` is the public surface
 * `cvault add` calls. It encrypts the plaintext blob server-side using
 * VAULT_AES_KEY, then delegates to the internal `upsertEncrypted` mutation.
 *
 * The CLI never holds the master key — only the Convex deployment does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import { __setAnthropicFetch } from './anthropic'
import { decrypt } from './crypto'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 13).toString('base64')
  // upsertFromPlaintext schedules an immediate fetchUsageForSub. Stub the
  // Anthropic call so the scheduled function completes (returns null on
  // !ok) instead of trying to hit the real network from the test env.
  __setAnthropicFetch((() => Promise.resolve(new Response('rate-limited', { status: 429 }))) as typeof fetch)
  // Use fake timers so finishAllScheduledFunctions can drain inside the
  // test transaction window — otherwise convex-test's scheduler fires
  // on a real setTimeout AFTER the test ends, hitting an expired fake
  // transaction and surfacing "Write outside of transaction" rejections.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  __setAnthropicFetch(undefined)
  if (ORIGINAL_KEY === undefined) {
    delete process.env.VAULT_AES_KEY
  } else {
    process.env.VAULT_AES_KEY = ORIGINAL_KEY
  }
})

const SAMPLE_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-FRESH-AAAAAAAAAAAAAAAAAAAAAAAA',
    refreshToken: 'sk-ant-ort01-FRESH-BBBBBBBBBBBBBBBBBBBBBBBB',
    expiresAt: 1700000000000,
    scopes: ['user:inference'],
  },
})

describe('subscriptions.actions.upsertFromPlaintext', () => {
  it('throws when caller is not authenticated', async () => {
    const t = vault()
    await expect(
      t.action(api.subscriptions.actions.upsertFromPlaintext, {
        email: 'a@example.com',
        plaintextBlob: SAMPLE_BLOB,
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      })
    ).rejects.toThrow(/authenticated/i)
  })

  it('encrypts the plaintext and persists it as ciphertext+nonce', async () => {
    const t = vault()
    await seedUser(t)

    const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'fresh@example.com',
      plaintextBlob: SAMPLE_BLOB,
      expiresAt: Date.now() + 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // Drain the scheduled fetchUsageForSub. It'll fail (no Anthropic
    // fetch stub) but failure is caught inside the action itself; we
    // only need to clear the scheduler queue so the test transaction
    // window closes cleanly.
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(result.created).toBe(true)
    expect(result.slot).toBe(1)

    // Confirm the row was written and decrypts to the original blob.
    const row = await t.run(async (ctx) => await ctx.db.get('subscriptions', result.subId))
    expect(row).not.toBeNull()
    expect(row?.email).toBe('fresh@example.com')
    // The stored ciphertext is NOT the plaintext (defense-in-depth check).
    const ciphertextHex = Buffer.from(row?.ciphertext ?? new ArrayBuffer(0)).toString('hex')
    expect(ciphertextHex).not.toContain(Buffer.from(SAMPLE_BLOB).toString('hex'))

    // Decrypting with the same VAULT_AES_KEY recovers the plaintext.
    const recovered = decrypt(row?.ciphertext ?? new ArrayBuffer(0), row?.nonce ?? new ArrayBuffer(0), row?.keyVersion)
    expect(recovered).toBe(SAMPLE_BLOB)
  })

  it("inserts a machineActivity row with action='add' on first upsert", async () => {
    const t = vault()
    await seedUser(t)

    const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'audit-add@example.com',
      plaintextBlob: SAMPLE_BLOB,
      expiresAt: Date.now() + 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const addRow = rows.find((r) => r.action === 'add')
    expect(addRow).toBeDefined()
    expect(addRow?.subscriptionId).toEqual(result.subId)
  })

  /**
   * RT-dead recovery path. After Anthropic answers `invalid_grant`,
   * `markReloginRequired` clamps `refreshExpiresAt` into the past so the
   * in-action defense stops driving Anthropic. The user's recovery is
   * `cvault add` — which lands here. If this path doesn't CLEAR the
   * prior `refreshExpiresAt` clamp, the sub stays "RT-dead" forever
   * and pull-on-use callers (`pullForSwitch`) keep getting the
   * REFRESH_FAILED error even after a successful re-capture.
   */
  it('clears stale refreshExpiresAt when re-capturing a sub previously marked reloginRequired', async () => {
    const t = vault()
    await seedUser(t)

    // First add: a normal capture.
    const first = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'recover@example.com',
      plaintextBlob: SAMPLE_BLOB,
      expiresAt: Date.now() + 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    // Simulate Anthropic having returned `invalid_grant` against the prior
    // refresh: the action would have called `markReloginRequired`, which
    // clamps `refreshExpiresAt` into the past. Set it manually here to
    // model that prior state without driving the full failure path.
    const now = Date.now()
    await t.run(async (ctx) => {
      await ctx.db.patch('subscriptions', first.subId, { refreshExpiresAt: now - 60_000 })
    })
    const beforeReadd = await t.run(async (ctx) => await ctx.db.get('subscriptions', first.subId))
    expect(beforeReadd?.refreshExpiresAt).toBeLessThan(now)

    // User runs `cvault add` again with a fresh blob from the laptop they
    // just successfully re-logged in on. The CLI does NOT pass
    // `refreshExpiresAt` because Anthropic doesn't echo a refresh-token
    // expiry in the OAuth response — only the AT lifetime. The recovery
    // contract is: this re-capture MUST clear the stale clamp so the
    // cron resumes proactive refresh on the next tick.
    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'recover@example.com',
      plaintextBlob: SAMPLE_BLOB,
      expiresAt: Date.now() + 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const afterReadd = await t.run(async (ctx) => await ctx.db.get('subscriptions', first.subId))
    expect(afterReadd?.refreshExpiresAt).toBeUndefined()
  })

  it('updates an existing sub in place (rotation, not duplicate)', async () => {
    const t = vault()
    await seedUser(t)

    const first = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'rotate@example.com',
      plaintextBlob: SAMPLE_BLOB,
      expiresAt: Date.now() + 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    expect(first.created).toBe(true)

    const newer = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-NEWER-CCCCCCCCCCCCCCCCCCCC',
        refreshToken: 'sk-ant-ort01-NEWER-DDDDDDDDDDDDDDDDDDDD',
        expiresAt: 1800000000000,
      },
    })
    const second = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'rotate@example.com',
      plaintextBlob: newer,
      expiresAt: Date.now() + 120 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(second.created).toBe(false)
    expect(second.subId).toEqual(first.subId)
    expect(second.slot).toBe(first.slot)

    // Decrypt the latest row -> should be the second blob, not the first.
    const row = await t.run(async (ctx) => await ctx.db.get('subscriptions', second.subId))
    const recovered = decrypt(row?.ciphertext ?? new ArrayBuffer(0), row?.nonce ?? new ArrayBuffer(0), row?.keyVersion)
    expect(recovered).toBe(newer)
  })

  it('upsertFromPlaintext stores the current keyVersion on the row', async () => {
    const ORIGINAL_VERSION = process.env.VAULT_KEY_VERSION
    process.env.VAULT_KEY_VERSION = 'v7'
    try {
      const t = vault()
      await seedUser(t)
      const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
        email: 'kv@example.com',
        plaintextBlob: SAMPLE_BLOB,
        expiresAt: 1,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      })
      await t.finishAllScheduledFunctions(vi.runAllTimers)
      const row = await t.run(async (ctx) => await ctx.db.get('subscriptions', result.subId))
      expect(row?.keyVersion).toBe('v7')
    } finally {
      if (ORIGINAL_VERSION === undefined) delete process.env.VAULT_KEY_VERSION
      else process.env.VAULT_KEY_VERSION = ORIGINAL_VERSION
    }
  })
})
