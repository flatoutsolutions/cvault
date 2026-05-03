/**
 * Scenario #14 — Token redaction in logs.
 *
 * Plan: docs/research/scenario-tests-plan.md §4.14
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §6 + §10
 *
 * Anthropic returns a 5xx with a body that echoes a token-shaped string.
 * The refresh action must:
 *  - run that body through `redactTokens()` BEFORE persisting to
 *    `refreshLog.error`
 *  - end up with `<redacted>` in place of every `sk-ant-{type}{digits}-…`
 *    substring
 *  - still surface a usable failure outcome (`outcome='failure'`, since
 *    5xx is transient — not relogin-required)
 *
 * Companion coverage:
 *  - `convex/subscriptions/redact.test.ts` covers the regex itself (5 tests).
 *  - `convex/subscriptions/refresh.test.ts` covers the 401 branch's redaction.
 *
 * THIS scenario covers the 5xx wiring branch — i.e. that the redaction
 * fires regardless of which HTTP error path we take. Locking it in here
 * prevents a regression where someone refactors the 5xx path and forgets
 * to call `redactTokens(errMsg)`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'
import { __setAnthropicFetch, __setRandomBytesForTest } from '../subscriptions/anthropic'
import { buildOauthBlob, makeAnthropicFetchStub, seedSubscription, withVaultKey } from './_helpers.scenario'

let keyHandle: ReturnType<typeof withVaultKey>

beforeEach(() => {
  keyHandle = withVaultKey(19)
})

afterEach(() => {
  keyHandle.restore()
  __setAnthropicFetch(undefined)
  __setRandomBytesForTest(undefined)
})

describe('scenario #14 — token redaction in refresh failure logs', () => {
  it('5xx Anthropic body echoes a token shape: log.error has tokens replaced by <redacted>', async () => {
    const t = vault()

    // ---------- SETUP ----------
    const seedExpiresAt = Date.now() + 60_000
    const initialBlob = buildOauthBlob({
      accessSuffix: 'REDACT-INITIAL-AAAAAAAAAAAAAAAAAAAAA',
      refreshSuffix: 'REDACT-INITIAL-BBBBBBBBBBBBBBBBBBBBB',
      expiresAt: seedExpiresAt,
    })
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'redact@example.com',
      expiresAt: seedExpiresAt,
      blob: initialBlob,
    })

    // Stub Anthropic to 500 with a body that contains BOTH token shapes
    // (access + refresh) embedded in the error message — simulating a
    // misbehaving upstream that echoes credentials back.
    const leakedAccess = 'sk-ant-oat01-LEAKED-ACCESS-XXXXXXXXXXXXXXXXX'
    const leakedRefresh = 'sk-ant-ort01-LEAKED-REFRESH-YYYYYYYYYYYYYYYY'
    __setAnthropicFetch(
      makeAnthropicFetchStub({
        status: 500,
        body: {
          error: 'internal_server_error',
          error_description: `Internal error processing ${leakedAccess} (refresh ${leakedRefresh}): upstream timeout`,
        },
      })
    )

    // ---------- RUN ----------
    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: seeded.subId,
      triggeredBy: 'cron',
    })

    // ---------- ASSERTIONS ----------
    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('failure')
    expect(logs[0]?.triggeredBy).toBe('cron')

    const errorText = logs[0]?.error ?? ''
    // Critical: NO leaked token substring is persisted.
    expect(errorText).not.toContain(leakedAccess)
    expect(errorText).not.toContain(leakedRefresh)
    expect(errorText).not.toMatch(/sk-ant-oat01-/)
    expect(errorText).not.toMatch(/sk-ant-ort01-/)
    // The redaction marker IS present (twice — once per leaked token).
    expect(errorText).toContain('<redacted>')
    const redactedCount = (errorText.match(/<redacted>/g) ?? []).length
    expect(redactedCount).toBeGreaterThanOrEqual(2)

    // The non-token surrounding context is preserved (so the operator can
    // still see what failed). The exact prefix is "Anthropic refresh 500: ".
    expect(errorText).toContain('500')
    expect(errorText).toContain('upstream timeout')

    // Sub state: lease released so next cron tick can retry. refreshExpiresAt
    // unchanged (5xx is transient, not a dead-token signal).
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', seeded.subId))
    expect(after?.refreshLeaseHolder).toBeUndefined()
    expect(after?.refreshLeaseUntil).toBeUndefined()
  })

  it('503 with raw-text token-shaped body (non-JSON): still redacts tokens before persisting', async () => {
    // Anthropic occasionally returns plain-text 5xx pages (e.g. CDN/edge
    // errors). The action's `result.rawBody.slice(0,500)` path goes through
    // redact, so plain text MUST also be sanitized.
    const t = vault()

    const seedExpiresAt = Date.now() + 60_000
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'rawtext@example.com',
      expiresAt: seedExpiresAt,
    })

    const leakedRefresh = 'sk-ant-ort01-EDGE-CDN-ZZZZZZZZZZZZZZZZZZZZZZ'
    __setAnthropicFetch(
      makeAnthropicFetchStub({
        status: 503,
        rawBody: `<html><body>503 Service Unavailable: failed proxying ${leakedRefresh}</body></html>`,
        contentType: 'text/html',
      })
    )

    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: seeded.subId,
      triggeredBy: 'cron',
    })

    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('failure')

    const errorText = logs[0]?.error ?? ''
    expect(errorText).not.toContain(leakedRefresh)
    expect(errorText).not.toMatch(/sk-ant-ort01-/)
    expect(errorText).toContain('<redacted>')
    expect(errorText).toContain('503')
  })

  it('429 (rate limit) with token-shaped body: redaction still applies', async () => {
    // Defensive third case: the redaction wiring must apply uniformly to
    // all non-401/400-invalid_grant paths. 429 ends up in the same generic
    // failure branch as 5xx.
    const t = vault()

    const seedExpiresAt = Date.now() + 60_000
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'rate@example.com',
      expiresAt: seedExpiresAt,
    })

    const leakedAccess = 'sk-ant-oat01-RATE-LIMIT-WWWWWWWWWWWWWWWWWWWW'
    __setAnthropicFetch(
      makeAnthropicFetchStub({
        status: 429,
        body: {
          error: 'rate_limited',
          error_description: `Token ${leakedAccess} hit rate limit`,
        },
      })
    )

    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: seeded.subId,
      triggeredBy: 'cron',
    })

    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('failure')
    const errorText = logs[0]?.error ?? ''
    expect(errorText).not.toContain(leakedAccess)
    expect(errorText).toContain('<redacted>')
    expect(errorText).toContain('429')
  })
})
