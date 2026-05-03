/**
 * Scenario — RELOGIN_REQUIRED user-side recovery loop.
 *
 * Background:
 *   When Anthropic answers `invalid_grant`, `markReloginRequired` clamps
 *   the sub's `refreshExpiresAt` to `Date.now()`. This is the marker
 *   that:
 *     - the dashboard renders as a "⚠ relogin" badge,
 *     - the cron filter (`findExpiringSubs` / `listAllActiveSubIds`) uses
 *       to EXCLUDE the sub from refresh attempts (the cron-spam fix),
 *     - the in-action defense (`refreshOAuthToken`) re-checks after the
 *       lease and bails before the HTTP step.
 *
 *   The user's recovery is `cvault add` on the laptop where Claude Code
 *   most recently rotated locally. That re-captures fresh tokens
 *   server-side via `subscriptions.actions.upsertFromPlaintext`. The
 *   re-capture path MUST clear the stale `refreshExpiresAt` clamp —
 *   otherwise the sub stays "RT-dead" forever even after a successful
 *   re-add, and the cron will never resume proactive refresh.
 *
 * What this scenario asserts (the END-TO-END recovery loop):
 *   1. Seed a sub, mark it RT-dead.
 *   2. The dashboard's `listForUser` query exposes `refreshExpiresAt` so
 *      the UI can render the "⚠ relogin" badge.
 *   3. User runs `cvault add` (→ `upsertFromPlaintext`) with a fresh blob.
 *   4. The sub's `refreshExpiresAt` is cleared (back to `undefined`).
 *   5. The next cron tick now PICKS UP the sub (it's no longer
 *      excluded by the cron filter) and refresh succeeds against a
 *      mocked Anthropic 200.
 *
 * If any step regresses, the user gets stuck in the "perpetual relogin"
 * state Stefan saw in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from '../../_generated/api'
import { __setAnthropicFetch } from '../../subscriptions/anthropic'
import { decrypt, encrypt } from '../../subscriptions/crypto'
import { TEST_IDENTITY, seedUser, vault } from '../helpers'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 41).toString('base64')
  __setAnthropicFetch((() => Promise.resolve(new Response('rate-limited', { status: 429 }))) as typeof fetch)
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

function makePlaintextBlob(opts: { expiresAt: number; versionSuffix: string }): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat01-${opts.versionSuffix}-AT-AAAAAAAAAAAAAAAA`,
      refreshToken: `sk-ant-ort01-${opts.versionSuffix}-RT-BBBBBBBBBBBBBBBB`,
      expiresAt: opts.expiresAt,
      scopes: ['user:inference'],
    },
  })
}

describe('Scenario — RELOGIN_REQUIRED recovery via cvault add → cron resumes', () => {
  it('full recovery loop: seed RT-dead → dashboard shows flag → cvault add clears clamp → cron picks up + succeeds', async () => {
    const t = vault()
    await seedUser(t)

    // ---------- Phase 1 — Seed RT-dead sub ----------
    // The sub's access token IS in the cron's proactive window (so the
    // cron filter is what's keeping it out, not the access-token expiry).
    // refreshExpiresAt is clamped into the past — the marker `markReloginRequired`
    // writes after Anthropic answered `invalid_grant`.
    const accessExpires = Date.now() + 60_000
    const initialBlob = makePlaintextBlob({ expiresAt: accessExpires, versionSuffix: 'STALE' })
    const { ciphertext: ct0, nonce: n0, keyVersion: ct0KV } = encrypt(initialBlob)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'recover@example.com',
      ciphertext: ct0,
      nonce: n0,
      keyVersion: ct0KV,
      expiresAt: accessExpires,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.run(async (ctx) => {
      await ctx.db.patch('subscriptions', inserted.subId, {
        refreshExpiresAt: Date.now(),
      })
    })

    // ---------- Phase 2 — Dashboard surfaces the flag ----------
    // The frontend's "Subscriptions" page reads `listForUser` and renders
    // a "⚠ relogin" badge whenever `refreshExpiresAt <= now`. Verify the
    // query exposes the field; without it the badge would be invisible
    // and the user wouldn't know they need to recover.
    const dashboardRows = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(dashboardRows).toHaveLength(1)
    expect(dashboardRows[0]?.email).toBe('recover@example.com')
    expect(dashboardRows[0]?.refreshExpiresAt).toBeDefined()
    expect(dashboardRows[0]?.refreshExpiresAt).toBeLessThanOrEqual(Date.now())

    // ---------- Phase 3 — User runs `cvault add` to recapture ----------
    // The CLI calls `upsertFromPlaintext` with a fresh blob from the
    // laptop where Claude Code most recently rotated locally. The CLI
    // does NOT pass `refreshExpiresAt` (Anthropic doesn't echo a refresh
    // token expiry in the OAuth response — only the AT lifetime).
    const freshAccessExpires = Date.now() + 60 * 60 * 1000
    const freshBlob = makePlaintextBlob({ expiresAt: freshAccessExpires, versionSuffix: 'FRESH' })
    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'recover@example.com',
      plaintextBlob: freshBlob,
      expiresAt: freshAccessExpires,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    // Drain the immediate `fetchUsageForSub` scheduled by upsert. Stub
    // Anthropic returns 429 → action exits silently → scheduler queue
    // closes cleanly.
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    // ---------- Phase 4 — refreshExpiresAt cleared ----------
    // The recovery contract: re-capturing a sub previously marked
    // reloginRequired MUST unset the stale clamp. If this regresses, the
    // sub stays excluded from the cron forever.
    const afterRecover = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(afterRecover?.refreshExpiresAt).toBeUndefined()
    // The blob was rotated to FRESH.
    const recoveredPlaintext = decrypt(
      afterRecover?.ciphertext ?? new ArrayBuffer(0),
      afterRecover?.nonce ?? new ArrayBuffer(0),
      afterRecover?.keyVersion
    )
    expect(recoveredPlaintext).toContain('FRESH')

    // The dashboard query no longer reports a clamp.
    const dashboardAfter = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(dashboardAfter[0]?.refreshExpiresAt).toBeUndefined()

    // ---------- Phase 5 — Cron resumes refresh + succeeds ----------
    // Push the access token back into the proactive-refresh window so
    // the next cron tick will want to refresh it. The sub is no longer
    // RT-dead (refreshExpiresAt cleared), so the filter should NOW
    // include it.
    const nearExpiry = Date.now() + 60_000
    await t.run(async (ctx) => {
      await ctx.db.patch('subscriptions', inserted.subId, { expiresAt: nearExpiry })
    })

    // Mock Anthropic to return a fresh rotated token (status 200).
    let anthropicCalls = 0
    __setAnthropicFetch(
      vi.fn(() => {
        anthropicCalls += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'sk-ant-oat01-RECOVERED-CCCCCCCCCCCCCC',
              refresh_token: 'sk-ant-ort01-RECOVERED-DDDDDDDDDDDDDD',
              expires_in: 8 * 60 * 60,
              scope: 'user:inference',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      }) as typeof fetch
    )

    await t.action(internal.subscriptions.crons.refreshExpiringTokens, {})

    // INVARIANT: the cron picked up the recovered sub (it called Anthropic).
    expect(anthropicCalls).toBe(1)

    // Refresh succeeded: expiresAt advanced, refreshLog has a success row,
    // refreshExpiresAt is still unset (no new invalid_grant).
    const final = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(final?.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
    expect(final?.refreshExpiresAt).toBeUndefined()

    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    const successRows = logs.filter((l) => l.outcome === 'success')
    expect(successRows).toHaveLength(1)
    expect(successRows[0]?.triggeredBy).toBe('cron')
  })

  it('cron does NOT pick up an RT-dead sub before recovery — proves the fix is gating, not the test setup', async () => {
    // Counter-test for the recovery scenario: BEFORE recovery, the cron
    // must NOT pick up the RT-dead sub. This rules out the trivial
    // failure mode where the test seems to pass because the cron picks
    // up everything regardless.
    const t = vault()
    await seedUser(t)
    const accessExpires = Date.now() + 60_000
    const blob = makePlaintextBlob({ expiresAt: accessExpires, versionSuffix: 'DEAD' })
    const { ciphertext, nonce, keyVersion } = encrypt(blob)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'gating@example.com',
      ciphertext,
      nonce,
      keyVersion,
      expiresAt: accessExpires,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.run(async (ctx) => {
      await ctx.db.patch('subscriptions', inserted.subId, {
        refreshExpiresAt: Date.now(),
      })
    })

    let anthropicCalls = 0
    __setAnthropicFetch(
      vi.fn(() => {
        anthropicCalls += 1
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      }) as typeof fetch
    )

    await t.action(internal.subscriptions.crons.refreshExpiringTokens, {})

    // The cron filter excluded the RT-dead sub: zero Anthropic calls.
    expect(anthropicCalls).toBe(0)
    // No new refreshLog rows — the sub was filtered before the action ran.
    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(0)
  })

  it('pollUsage cron also skips RT-dead subs (mirroring refreshExpiringTokens — both crons share the filter)', async () => {
    // The cron-spam fix also gates `pollUsage` (via `listAllActiveSubIds`'s
    // `isReloginRequired` filter). Without this, `pollUsage` would burn
    // an Anthropic usage call every 5 minutes against a token whose
    // refresh path is dead.
    const t = vault()
    await seedUser(t)
    const accessExpires = Date.now() + 60 * 60 * 1000
    const blob = makePlaintextBlob({ expiresAt: accessExpires, versionSuffix: 'DEAD' })
    const { ciphertext, nonce, keyVersion } = encrypt(blob)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'pollskip@example.com',
      ciphertext,
      nonce,
      keyVersion,
      expiresAt: accessExpires,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.run(async (ctx) => {
      await ctx.db.patch('subscriptions', inserted.subId, {
        refreshExpiresAt: Date.now(),
      })
    })

    let usageCalls = 0
    __setAnthropicFetch(
      vi.fn(() => {
        usageCalls += 1
        return Promise.resolve(new Response('{}', { status: 429 }))
      }) as typeof fetch
    )

    await t.action(internal.subscriptions.crons.pollUsage, {})

    expect(usageCalls).toBe(0)
  })
})
