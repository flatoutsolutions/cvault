/**
 * Scenario #8 (backend half) — Refresh dead (relogin required).
 *
 * Plan: docs/research/scenario-tests-plan.md §4.8
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §10
 *
 * Anthropic returns `invalid_grant` (the OAuth-standard "refresh token is
 * dead, owner must re-login" signal). The refresh action must:
 *  - clamp `refreshExpiresAt` to now (so the dashboard surfaces the
 *    "⚠ relogin" badge per spec §8)
 *  - release the refresh lease holder/until fields
 *  - write a `refreshLog` row with `outcome='reloginRequired'`
 *  - leave the underlying ciphertext untouched (the access token is now
 *    stale, but until the user re-adds, we don't overwrite the blob)
 *
 * Per backend agent's IMPLEMENTATION_NOTES.md §"Spec deviations (backend)":
 *  > 400 invalid_grant is treated identically to 401 invalid_grant
 *  > (both -> reloginRequired). Spec §10 mentioned only 401; the OAuth
 *  > research brief documents that providers commonly return 400 too.
 *
 * This scenario asserts BOTH the 401 and 400 paths to lock that mandate in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { internal } from '../_generated/api'
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
  keyHandle = withVaultKey(15)
})

afterEach(() => {
  keyHandle.restore()
  __setAnthropicFetch(undefined)
  __setRandomBytesForTest(undefined)
})

describe('scenario #8 — refresh dead (relogin required)', () => {
  it('401 invalid_grant: refreshExpiresAt clamped to now, log outcome=reloginRequired, no token leakage', async () => {
    const t = vault()

    // ---------- SETUP ----------
    // Seed a sub close to expiry so the refresh path actually runs.
    // refreshExpiresAt is set 30 days in the future to prove that the
    // 401 handling clamps it back to now.
    const seedExpiresAt = Date.now() + 60_000
    const seedRefreshExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000
    const initialBlob = buildOauthBlob({
      accessSuffix: 'DEAD-INITIAL-AAAAAAAAAAAAAAAAAAAAAA',
      refreshSuffix: 'DEAD-INITIAL-BBBBBBBBBBBBBBBBBBBBBB',
      expiresAt: seedExpiresAt,
    })
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'dead@example.com',
      expiresAt: seedExpiresAt,
      refreshExpiresAt: seedRefreshExpiresAt,
      blob: initialBlob,
    })

    // Snapshot pre-refresh ciphertext bytes — must be unchanged after.
    const before = await t.run(
      async (ctx) => await ctx.db.get('subscriptions', seeded.subId)
    )
    const beforeCtHex = Buffer.from(before?.ciphertext ?? new ArrayBuffer(0)).toString(
      'hex'
    )

    // Stub Anthropic 401 with the OAuth-standard `invalid_grant` body.
    const fetchStub = makeAnthropicFetchStub({
      status: 401,
      body: {
        error: 'invalid_grant',
        error_description: 'refresh token expired',
      },
    })
    __setAnthropicFetch(fetchStub)

    // ---------- RUN ----------
    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: seeded.subId,
      triggeredBy: 'manual',
    })

    // ---------- ASSERTIONS ----------
    expect(fetchStub).toHaveBeenCalledTimes(1)

    const after = await t.run(
      async (ctx) => await ctx.db.get('subscriptions', seeded.subId)
    )
    expect(after).not.toBeNull()
    // refreshExpiresAt clamped to ~now (was 30 days out).
    expect(after?.refreshExpiresAt).toBeLessThanOrEqual(Date.now())
    expect(after?.refreshExpiresAt ?? 0).toBeGreaterThan(Date.now() - 60_000)
    // Lease cleared.
    expect(after?.refreshLeaseHolder).toBeUndefined()
    expect(after?.refreshLeaseUntil).toBeUndefined()
    // Ciphertext untouched — the dead access token stays in place until
    // the user re-adds. We do NOT overwrite the blob with anything.
    const afterCtHex = Buffer.from(after?.ciphertext ?? new ArrayBuffer(0)).toString(
      'hex'
    )
    expect(afterCtHex).toBe(beforeCtHex)

    // refreshLog row: reloginRequired.
    const logs = await t.run(
      async (ctx) => await ctx.db.query('refreshLog').collect()
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('reloginRequired')
    expect(logs[0]?.subscriptionId).toEqual(seeded.subId)
    expect(logs[0]?.userId).toEqual(seeded.userId)
    expect(logs[0]?.triggeredBy).toBe('manual')
    // Error string is non-empty (the 401 body) and free of leaked tokens.
    const errorText = logs[0]?.error ?? ''
    expect(errorText.length).toBeGreaterThan(0)
    expect(errorText).not.toMatch(/sk-ant-oat01/)
    expect(errorText).not.toMatch(/sk-ant-ort01/)
  })

  it('400 invalid_grant (per backend mandate): same behavior as 401 — refreshExpiresAt clamped, log outcome=reloginRequired', async () => {
    const t = vault()

    const seedExpiresAt = Date.now() + 60_000
    const seedRefreshExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'dead400@example.com',
      expiresAt: seedExpiresAt,
      refreshExpiresAt: seedRefreshExpiresAt,
    })

    // Anthropic 400 with the same OAuth-standard body. Per the IMPLEMENTATION_NOTES
    // mandate, this MUST be treated as reloginRequired (some OAuth providers
    // return 400 instead of 401 for invalid_grant).
    const fetchStub = makeAnthropicFetchStub({
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: 'refresh token has been revoked',
      },
    })
    __setAnthropicFetch(fetchStub)

    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: seeded.subId,
      triggeredBy: 'cron',
    })

    expect(fetchStub).toHaveBeenCalledTimes(1)

    const after = await t.run(
      async (ctx) => await ctx.db.get('subscriptions', seeded.subId)
    )
    // FIX-PENDING (covered by backend agent's IMPLEMENTATION_NOTES.md §"Spec
    // deviations"): if the action treats 400 as a generic failure instead of
    // reloginRequired, refreshExpiresAt won't be clamped and this assert will
    // fail. As of writing, actions.ts already implements the 400-as-relogin
    // path (lines 251-264) so this should pass.
    expect(after?.refreshExpiresAt).toBeLessThanOrEqual(Date.now())
    expect(after?.refreshLeaseHolder).toBeUndefined()

    const logs = await t.run(
      async (ctx) => await ctx.db.query('refreshLog').collect()
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('reloginRequired')
    expect(logs[0]?.triggeredBy).toBe('cron')
  })

  it('400 with non-invalid_grant body falls through to plain failure (NOT reloginRequired)', async () => {
    // Defensive: a 400 with `error: "invalid_request"` (e.g. malformed
    // request, not a dead token) must NOT trigger relogin. This locks in
    // the "only invalid_grant" branch of the IMPLEMENTATION_NOTES mandate.
    const t = vault()

    const seedExpiresAt = Date.now() + 60_000
    const seedRefreshExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'malformed@example.com',
      expiresAt: seedExpiresAt,
      refreshExpiresAt: seedRefreshExpiresAt,
    })

    __setAnthropicFetch(
      makeAnthropicFetchStub({
        status: 400,
        body: {
          error: 'invalid_request',
          error_description: 'malformed grant_type',
        },
      })
    )

    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: seeded.subId,
      triggeredBy: 'cron',
    })

    const after = await t.run(
      async (ctx) => await ctx.db.get('subscriptions', seeded.subId)
    )
    // refreshExpiresAt UNTOUCHED (still 30d out). Lease released so next
    // cron tick can retry.
    expect(after?.refreshExpiresAt).toBe(seedRefreshExpiresAt)
    expect(after?.refreshLeaseHolder).toBeUndefined()

    const logs = await t.run(
      async (ctx) => await ctx.db.query('refreshLog').collect()
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('failure')
  })
})
