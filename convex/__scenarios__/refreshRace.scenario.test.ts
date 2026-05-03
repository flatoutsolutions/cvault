/**
 * Scenario #7 — Refresh race (lease CAS protection).
 *
 * Plan: docs/research/scenario-tests-plan.md §4.7
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §9
 *
 * Two concurrent refresh attempts hit the same expiring sub. Only one
 * acquires the lease. The loser sleeps 1 second, re-checks, sees a fresh
 * tuple, and aborts silently — no second Anthropic call, exactly one
 * refreshLog row, lease released cleanly.
 *
 * Real wall-clock timing: per the plan §4.7 we deliberately do NOT fake
 * timers because the lease's real-world property *is* "loser waits 1s,
 * retries". Faking timers would defeat the purpose. Hence the slightly
 * long runtime (~1.3s).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'
import { __setAnthropicFetch, __setRandomBytesForTest } from '../subscriptions/anthropic'
import { buildOauthBlob, makeAnthropicSequenceStub, seedSubscription, withVaultKey } from './_helpers.scenario'

let keyHandle: ReturnType<typeof withVaultKey>

beforeEach(() => {
  keyHandle = withVaultKey(13)
})

afterEach(() => {
  keyHandle.restore()
  __setAnthropicFetch(undefined)
  __setRandomBytesForTest(undefined)
})

describe('scenario #7 — refresh race', () => {
  // 5s test timeout: the loser sleeps 1s, plus comfortable headroom.
  // (Vitest 4: timeout is the third positional arg, not an options object.)
  it('two concurrent refresh attempts: only the winner calls Anthropic; loser sleeps, sees fresh tuple, aborts silently', async () => {
    const t = vault()

    // ---------- SETUP ----------
    // Seed a sub close to expiry (so each call would normally proceed
    // through the lease + Anthropic call).
    const seedExpiresAt = Date.now() + 2 * 60 * 1000
    const initialBlob = buildOauthBlob({
      accessSuffix: 'RACE-INITIAL-AAAAAAAAAAAAAAAAAAAAAA',
      refreshSuffix: 'RACE-INITIAL-BBBBBBBBBBBBBBBBBBBBBB',
      expiresAt: seedExpiresAt,
    })
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'race@example.com',
      expiresAt: seedExpiresAt,
      blob: initialBlob,
    })

    // Stub Anthropic with a multi-call counter. The first response is
    // the "winner's" fresh tuple. If the loser's call ever fires, it
    // would see a *different* second response — used as evidence later
    // that the loser did NOT call.
    const fetchStub = makeAnthropicSequenceStub([
      {
        status: 200,
        body: {
          access_token: 'sk-ant-oat01-RACE-WINNER-CCCCCCCCCCCCCCCCCC',
          refresh_token: 'sk-ant-ort01-RACE-WINNER-DDDDDDDDDDDDDDDDDD',
          expires_in: 28_800,
          scope: 'user:inference',
        },
      },
      {
        status: 200,
        body: {
          access_token: 'sk-ant-oat01-RACE-LOSER-EEEEEEEEEEEEEEEEEE',
          refresh_token: 'sk-ant-ort01-RACE-LOSER-FFFFFFFFFFFFFFFFFF',
          expires_in: 28_800,
          scope: 'user:inference',
        },
      },
    ])
    __setAnthropicFetch(fetchStub)

    // ---------- RUN ----------
    // Two refresh attempts dispatched concurrently. The lease CAS in
    // `tryAcquireRefreshLease` ensures only one wins.
    await Promise.all([
      t.action(internal.subscriptions.actions.refreshOAuthToken, {
        subId: seeded.subId,
        triggeredBy: 'manual',
      }),
      t.action(internal.subscriptions.actions.refreshOAuthToken, {
        subId: seeded.subId,
        triggeredBy: 'manual',
      }),
    ])

    // ---------- ASSERTIONS ----------
    // Critical invariant: Anthropic was called EXACTLY ONCE. The loser
    // saw the lease held, slept 1s, re-checked, found the access token
    // freshly extended (>5min out), and bailed without retrying.
    expect(fetchStub).toHaveBeenCalledTimes(1)

    // Final sub row carries the WINNER's tokens (decrypt + JSON.parse).
    const finalSub = await t.run(async (ctx) => await ctx.db.get('subscriptions', seeded.subId))
    expect(finalSub).not.toBeNull()
    const { decrypt } = await import('../subscriptions/crypto')
    const finalPlain = decrypt(finalSub?.ciphertext ?? new ArrayBuffer(0), finalSub?.nonce ?? new ArrayBuffer(0))
    expect(finalPlain).toContain('RACE-WINNER-CCCCCCCCCCCC')
    expect(finalPlain).not.toContain('RACE-LOSER')

    // Lease cleanly released — no orphaned lease holder/until fields.
    expect(finalSub?.refreshLeaseHolder).toBeUndefined()
    expect(finalSub?.refreshLeaseUntil).toBeUndefined()

    // Exactly one success row in refreshLog. The loser does NOT log
    // (it aborts silently — see actions.ts line ~204-209: the loser's
    // recheck path returns null without writing anything).
    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    const successLogs = logs.filter((l) => l.outcome === 'success')
    expect(successLogs).toHaveLength(1)
    expect(successLogs[0]?.subscriptionId).toEqual(seeded.subId)
    expect(successLogs[0]?.triggeredBy).toBe('manual')

    // No failure / reloginRequired rows leaked from the loser.
    const nonSuccess = logs.filter((l) => l.outcome !== 'success')
    expect(nonSuccess).toHaveLength(0)
  }, 5_000)
})
