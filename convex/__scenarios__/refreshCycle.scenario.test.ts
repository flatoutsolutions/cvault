/**
 * Scenario #6 — Auto-refresh near expiry (cron).
 *
 * Plan: docs/research/scenario-tests-plan.md §4.6
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5, §9, §10
 *
 * What this scenario asserts:
 *  - The cron worker `refreshExpiringTokens` finds subs whose access token
 *    expires within the 15-minute window.
 *  - For each, it acquires the lease, calls Anthropic refresh, and on a 200
 *    response: rotates ciphertext, advances expiresAt, releases the lease,
 *    and writes a `refreshLog` row with `outcome='success'`,
 *    `triggeredBy='cron'`.
 *  - A subsequent CLI-style pull (`pullForSwitch`) returns a contentHash
 *    that differs from the pre-refresh snapshot — proving CLIs that cached
 *    the old hash will re-import on next switch (the entire point of "the
 *    cron's refresh propagates to all machines on next use").
 *
 * Hermetic: uses convex-test in-memory + a vi.fn() stub installed via
 * `__setAnthropicFetch`. No real network, no real timers (we use real
 * wall-clock for `Date.now()` because the refresh action doesn't sleep
 * in the success path).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { api, internal } from '../_generated/api'
import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import {
  __setAnthropicFetch,
  __setRandomBytesForTest,
} from '../subscriptions/anthropic'
import {
  buildOauthBlob,
  makeAnthropicFetchStub,
  seedSubscription,
  withVaultKey,
} from './_helpers.scenario'

let keyHandle: ReturnType<typeof withVaultKey>

beforeEach(() => {
  keyHandle = withVaultKey(11)
})

afterEach(() => {
  keyHandle.restore()
  __setAnthropicFetch(undefined)
  __setRandomBytesForTest(undefined)
})

async function sha256Hex(input: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(input).digest('hex')
}

describe('scenario #6 — auto-refresh near expiry (cron)', () => {
  it(
    'refresh cron rotates ciphertext, advances expiresAt, logs success, and the new hash propagates via pullForSwitch',
    async () => {
      const t = vault()

      // ---------- SETUP ----------
      // Seed a sub whose access token expires 5 minutes from now (well
      // inside the cron's 15-minute REFRESH_WINDOW_MS).
      const seedExpiresAt = Date.now() + 5 * 60 * 1000
      const initialBlob = buildOauthBlob({
        accessSuffix: 'CRON-INITIAL-AAAAAAAAAAAAAAAAAAAAA',
        refreshSuffix: 'CRON-INITIAL-BBBBBBBBBBBBBBBBBBBBB',
        expiresAt: seedExpiresAt,
      })
      const seeded = await seedSubscription({
        t,
        identity: TEST_IDENTITY,
        email: 'cron@example.com',
        expiresAt: seedExpiresAt,
        blob: initialBlob,
      })

      // Snapshot the initial ciphertext + content hash so we can compare.
      const before = await t.run(
        async (ctx) => await ctx.db.get('subscriptions', seeded.subId)
      )
      expect(before).not.toBeNull()
      const beforeCtHex = Buffer.from(before?.ciphertext ?? new ArrayBuffer(0)).toString('hex')
      const beforeContentHash = await sha256Hex(initialBlob)

      // Stub Anthropic to return a fresh access+refresh tuple. expires_in is
      // 8 hours which is the typical Anthropic value (per oauth research).
      const fetchStub = makeAnthropicFetchStub({
        status: 200,
        body: {
          access_token: 'sk-ant-oat01-CRON-FRESH-CCCCCCCCCCCCCCCCCCCCCCC',
          refresh_token: 'sk-ant-ort01-CRON-FRESH-DDDDDDDDDDDDDDDDDDDDDDD',
          expires_in: 28_800,
          scope: 'user:inference',
        },
      })
      __setAnthropicFetch(fetchStub)

      // ---------- RUN: phase 1 (cron fires) ----------
      await t.action(internal.subscriptions.crons.refreshExpiringTokens, {})

      // ---------- ASSERTIONS: backend state after cron ----------
      // Anthropic was hit exactly once (one expiring sub).
      expect(fetchStub).toHaveBeenCalledTimes(1)

      const after = await t.run(
        async (ctx) => await ctx.db.get('subscriptions', seeded.subId)
      )
      expect(after).not.toBeNull()
      // expiresAt is now > 60min in the future (we returned 8h).
      expect(after?.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
      // Ciphertext bytes changed (fresh nonce + rotated tokens).
      const afterCtHex = Buffer.from(after?.ciphertext ?? new ArrayBuffer(0)).toString(
        'hex'
      )
      expect(afterCtHex).not.toBe(beforeCtHex)
      // Lease cleanly released.
      expect(after?.refreshLeaseHolder).toBeUndefined()
      expect(after?.refreshLeaseUntil).toBeUndefined()
      // lastRefreshedAt stamped close to now.
      expect(after?.lastRefreshedAt).toBeGreaterThan(Date.now() - 60_000)

      // refreshLog row: success, cron-triggered, owned by the right user/sub.
      const logs = await t.run(
        async (ctx) => await ctx.db.query('refreshLog').collect()
      )
      expect(logs).toHaveLength(1)
      expect(logs[0]?.outcome).toBe('success')
      expect(logs[0]?.triggeredBy).toBe('cron')
      expect(logs[0]?.subscriptionId).toEqual(seeded.subId)
      expect(logs[0]?.userId).toEqual(seeded.userId)
      // Successful refresh has no error field.
      expect(logs[0]?.error).toBeUndefined()

      // ---------- RUN: phase 2 (CLI pulls, sees new hash) ----------
      const pullResult = await t
        .withIdentity(TEST_IDENTITY)
        .action(api.subscriptions.actions.pullForSwitch, {
          slotOrEmail: 'cron@example.com',
        })

      // ---------- ASSERTIONS: pull returns new content ----------
      expect(pullResult.email).toBe('cron@example.com')
      expect(pullResult.slot).toBe(seeded.slot)
      // The plaintext we get back contains the FRESH access/refresh tokens.
      expect(pullResult.plaintextBlob).toContain('CRON-FRESH-CCCCCCCCCCCC')
      expect(pullResult.plaintextBlob).toContain('CRON-FRESH-DDDDDDDDDDDD')
      // Content hash differs from the pre-refresh snapshot, so any CLI
      // caching the old hash will re-import.
      expect(pullResult.contentHash).not.toBe(beforeContentHash)
      // The hash matches the freshly-decrypted plaintext.
      const expectedHash = await sha256Hex(pullResult.plaintextBlob)
      expect(pullResult.contentHash).toBe(expectedHash)

      // pullForSwitch shouldn't have re-triggered a refresh (the access
      // token is now valid for ~8h, far outside the 5-minute proactive
      // window). Stub still at 1 call total.
      expect(fetchStub).toHaveBeenCalledTimes(1)
    }
  )

  it('refresh cron skips subs whose token is still valid for > REFRESH_WINDOW_MS', async () => {
    const t = vault()

    // Seed a sub expiring 1 hour out — well outside the 15-min window.
    const farFuture = Date.now() + 60 * 60 * 1000
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'far@example.com',
      expiresAt: farFuture,
    })

    const fetchStub = makeAnthropicFetchStub({ status: 200, body: {} })
    __setAnthropicFetch(fetchStub)

    await t.action(internal.subscriptions.crons.refreshExpiringTokens, {})

    // Anthropic was NOT contacted — sub is still fresh.
    expect(fetchStub).not.toHaveBeenCalled()
    const after = await t.run(
      async (ctx) => await ctx.db.get('subscriptions', seeded.subId)
    )
    expect(after?.expiresAt).toBe(farFuture)

    // No refresh log row was written (no refresh attempt happened).
    const logs = await t.run(
      async (ctx) => await ctx.db.query('refreshLog').collect()
    )
    expect(logs).toHaveLength(0)
  })
})
