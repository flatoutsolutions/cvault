/**
 * Scenario — RELOGIN_REQUIRED user-side recovery loop (post audit fix #5).
 *
 * Background:
 *   When Anthropic answers `invalid_grant`, `markReloginRequired` clamps
 *   the sub's `refreshExpiresAt` to `Date.now()`. This is the marker
 *   that:
 *     - the dashboard renders as a "⚠ relogin" badge,
 *     - the in-action defense (`refreshOAuthToken`) re-checks after the
 *       lease and bails before the HTTP step,
 *     - the `listAllActiveSubIds` filter uses to EXCLUDE the sub from
 *       the `pollUsage` cron's fanout.
 *
 *   The user's recovery is `cvault add` on the laptop where Claude Code
 *   most recently rotated locally. That re-captures fresh tokens
 *   server-side via `subscriptions.actions.upsertFromPlaintext`. The
 *   re-capture path MUST clear the stale `refreshExpiresAt` clamp.
 *
 * What this scenario asserts now:
 *   The `pollUsage` cron skips RT-dead subs. The original
 *   `refreshExpiringTokens` end-to-end recovery loop was deleted as part
 *   of audit fix #5 (the cron itself was dropped — pull-on-use covers
 *   refresh in v1; see
 *   `convex/__tests__/scenarios/cronDoesNotPoisonStaleRT.scenario.test.ts`
 *   for the rationale). The dashboard-flag and `cvault add` recovery
 *   paths are still covered by `cronSpamFix.scenario.test.ts` and
 *   `upsertFromPlaintext.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from '../../_generated/api'
import { __setAnthropicFetch } from '../../subscriptions/anthropic'
import { encrypt } from '../../subscriptions/crypto'
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

describe('Scenario — RT-dead subs are excluded from pollUsage cron', () => {
  it('pollUsage cron skips RT-dead subs (via listAllActiveSubIds.isReloginRequired filter)', async () => {
    // Without this filter, `pollUsage` would burn an Anthropic usage
    // call every 5 minutes against a token whose refresh path is dead.
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
