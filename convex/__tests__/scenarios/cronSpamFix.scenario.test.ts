/**
 * Scenario — production cron-spam bug repro + fix verification.
 *
 * Bug background (from real production usage):
 *   `refreshExpiringTokens` cron runs every 10 minutes. The original
 *   `findExpiringSubs` query selected ALL subs whose access token was
 *   inside the 15-minute proactive window — including subs whose REFRESH
 *   TOKEN was already dead (Anthropic returned `invalid_grant` on a prior
 *   tick). Each tick re-drove Anthropic against the same dead RT, got the
 *   same `invalid_grant`, and inserted a new `reloginRequired` row.
 *   Stefan's audit log showed 21+ identical rows in 3.5 hours.
 *
 * Fix (already in tree, exercised here end-to-end):
 *   1. `findExpiringSubs` and `listAllActiveSubIds` filter out RT-dead
 *      subs (`refreshExpiresAt <= now`).
 *   2. `refreshOAuthToken` short-circuits in-action: after acquiring the
 *      lease it re-checks `refreshExpiresAt` and exits silently rather
 *      than calling Anthropic.
 *   3. `refreshLog.insert` dedupes consecutive `reloginRequired` rows for
 *      the same sub within 5 minutes.
 *
 * What this scenario asserts (the END-TO-END behavior the bug violated):
 *   - Three back-to-back cron ticks against an RT-dead sub make ZERO
 *     Anthropic fetches.
 *   - The sub state is unchanged across ticks (still RT-dead).
 *   - At most one `reloginRequired` row exists after the ticks (no spam).
 *   - The dedupe ALSO catches an in-action attempt that bypasses the cron
 *     filter — e.g. a manual `cvault refresh` directly invoking
 *     `refreshOAuthToken` against an RT-dead sub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from '../../_generated/api'
import { __setAnthropicFetch } from '../../subscriptions/anthropic'
import { encrypt } from '../../subscriptions/crypto'
import { TEST_IDENTITY, seedUser, vault } from '../helpers'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 23).toString('base64')
  // Default: stub Anthropic so any UNEXPECTED call fails loud (HTTP 500).
  // Tests assert the call count is exactly 0 — if a regression sneaks in
  // and the cron starts hitting Anthropic again, the count assertion
  // catches it. The 500 body is just a safety net so the action's error
  // path doesn't itself throw something unexpected.
  __setAnthropicFetch((() => Promise.resolve(new Response('SHOULD NOT BE CALLED', { status: 500 }))) as typeof fetch)
})

afterEach(() => {
  __setAnthropicFetch(undefined)
  if (ORIGINAL_KEY === undefined) {
    delete process.env.VAULT_AES_KEY
  } else {
    process.env.VAULT_AES_KEY = ORIGINAL_KEY
  }
})

/**
 * Seed an "RT-dead" sub: access token is in the proactive-refresh window
 * (so the cron WOULD pick it up if not for the RT-dead filter), AND
 * `refreshExpiresAt` is clamped to `Date.now()` (the marker
 * `markReloginRequired` writes after Anthropic answered `invalid_grant`).
 */
async function seedRtDeadSub(t: ReturnType<typeof vault>): Promise<{
  subId: import('../../_generated/dataModel').Id<'subscriptions'>
  userId: import('../../_generated/dataModel').Id<'users'>
}> {
  const userId = await seedUser(t)
  const plaintext = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-DEAD-AAAAAAAAAAAAAAAAAAAA',
      refreshToken: 'sk-ant-ort01-DEAD-BBBBBBBBBBBBBBBBBBBB',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
    },
  })
  const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
  const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
    email: 'rtdead@example.com',
    ciphertext,
    nonce,
    keyVersion,
    expiresAt: Date.now() + 60_000,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
  })
  // Mark the sub RT-dead AFTER the upsert. Going through `upsert` first
  // gives us a proper `userId`/`slot` linkage; the patch then sets the
  // exact field the cron filter checks.
  await t.run(async (ctx) => {
    await ctx.db.patch('subscriptions', inserted.subId, {
      refreshExpiresAt: Date.now(),
    })
  })
  return { subId: inserted.subId, userId }
}

describe('Scenario — cron-spam fix prevents Anthropic hammering on RT-dead subs', () => {
  it('three back-to-back refreshExpiringTokens ticks make ZERO Anthropic calls + ZERO refreshLog rows', async () => {
    const t = vault()
    const { subId } = await seedRtDeadSub(t)

    let fetchCount = 0
    __setAnthropicFetch(
      vi.fn(() => {
        fetchCount += 1
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      }) as typeof fetch
    )

    // Snapshot the row before any cron tick so we can assert nothing changed.
    const before = await t.run(async (ctx) => await ctx.db.get('subscriptions', subId))
    expect(before?.refreshExpiresAt).toBeDefined()
    expect(before?.refreshExpiresAt).toBeLessThanOrEqual(Date.now())

    // Tick 1, 2, 3 — simulating 30 minutes of cron activity. Each call
    // SHOULD find no work to do because `findExpiringSubs` excludes the
    // RT-dead sub.
    for (let i = 0; i < 3; i += 1) {
      await t.action(internal.subscriptions.crons.refreshExpiringTokens, {})
    }

    // INVARIANT 1: Anthropic was NEVER called. The cron filter should
    // have excluded the sub from `findExpiringSubs`'s result; absent that
    // filter, three ticks would generate three `invalid_grant` calls.
    expect(fetchCount).toBe(0)

    // INVARIANT 2: NO refreshLog rows. The cron didn't pick up the sub,
    // so no row of any outcome (success, failure, or reloginRequired)
    // landed. Pre-fix this would have been at least 3.
    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(0)

    // INVARIANT 3: The sub's row is byte-identical to before — the cron
    // didn't accidentally mutate it (no clearing of refreshExpiresAt, no
    // shifting of expiresAt).
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', subId))
    expect(after?.refreshExpiresAt).toBe(before?.refreshExpiresAt)
    expect(after?.expiresAt).toBe(before?.expiresAt)
    expect(after?.lastRefreshedAt).toBe(before?.lastRefreshedAt)
  })

  it('manual refreshOAuthToken against an RT-dead sub bypasses cron filter, but in-action defense + dedupe still keep refreshLog clean', async () => {
    // This proves the layered defense works even when a future caller
    // invokes the inner action directly (skipping `findExpiringSubs`'s
    // pre-filter). Three direct invocations should still produce ZERO
    // Anthropic calls thanks to the lease-winner re-check, AND the dedupe
    // keeps `refreshLog` from accumulating spam if some path did slip
    // through.
    const t = vault()
    const { subId } = await seedRtDeadSub(t)

    let fetchCount = 0
    __setAnthropicFetch(
      vi.fn(() => {
        fetchCount += 1
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      }) as typeof fetch
    )

    // Three direct calls to the internal action — the in-action
    // refreshExpiresAt re-check (Track A guard 1) should cause each one
    // to exit silently after acquiring + releasing the lease.
    for (let i = 0; i < 3; i += 1) {
      await t.action(internal.subscriptions.actions.refreshOAuthToken, {
        subId,
        triggeredBy: 'manual',
      })
    }

    // INVARIANT 1: Anthropic was NEVER called. The in-action re-check
    // sees `refreshExpiresAt <= now` and bails before the HTTP step.
    expect(fetchCount).toBe(0)

    // INVARIANT 2: refreshLog stays empty. The in-action defense releases
    // the lease and returns null WITHOUT writing a refreshLog row — the
    // sub is already known-dead, no new information.
    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(0)
  })

  it('dedupe defense-in-depth: even if 3 reloginRequired rows are inserted in one tick, only 1 lands', async () => {
    // Models the worst case: a future code path bypasses BOTH upstream
    // guards (cron filter + in-action re-check) and lands in the
    // `markReloginRequired` + `refreshLog.insert` path multiple times in
    // the same tick. The dedupe in `refreshLog.mutations.insert` is the
    // last line of defense — it must collapse same-sub reloginRequired
    // rows within a 5-minute window.
    const t = vault()
    const { subId, userId } = await seedRtDeadSub(t)

    const now = Date.now()
    // Three rapid-fire reloginRequired inserts within 30 seconds — what
    // a regression in the dedupe would let through as 3 rows.
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'cron',
      outcome: 'reloginRequired',
      error: 'invalid_grant',
      at: now,
    })
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'cron',
      outcome: 'reloginRequired',
      error: 'invalid_grant',
      at: now + 10_000,
    })
    await t.mutation(internal.refreshLog.mutations.insert, {
      userId,
      subscriptionId: subId,
      triggeredBy: 'cron',
      outcome: 'reloginRequired',
      error: 'invalid_grant',
      at: now + 20_000,
    })

    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('reloginRequired')
  })
})
