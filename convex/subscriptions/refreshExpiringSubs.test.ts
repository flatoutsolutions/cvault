import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { __setAnthropicFetch } from './anthropic'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 13).toString('base64')
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  __setAnthropicFetch(undefined)
  if (ORIGINAL_KEY === undefined) delete process.env.VAULT_AES_KEY
  else process.env.VAULT_AES_KEY = ORIGINAL_KEY
})

describe('refreshExpiringSubs', () => {
  it('refreshes a sub that is within the proactive window', async () => {
    const t = vault()
    await seedUser(t)

    // Build a blob whose expiresAt is 60 seconds from now — well within
    // the REFRESH_PROACTIVE_MS (5 min) window so refreshOAuthToken fires.
    const nearExpiryAt = Date.now() + 60_000
    const BLOB = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-OLD-AAAAAAAAAAAAAAAAAAAAAAAA',
        refreshToken: 'sk-ant-ort01-OLD-BBBBBBBBBBBBBBBBBBBBBBBB',
        expiresAt: nearExpiryAt,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
      config: { oauthAccount: { emailAddress: 'refresh@example.com' } },
    })

    // Seed the sub. The upsert also schedules a fetchUsageForSub — stub
    // Anthropic to return 429 so it no-ops instead of hitting the network.
    __setAnthropicFetch((() => Promise.resolve(new Response('rate-limited', { status: 429 }))) as typeof fetch)

    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'refresh@example.com',
      plaintextBlob: BLOB,
      expiresAt: nearExpiryAt,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    // Drain the scheduled fetchUsageForSub before switching the stub.
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    // Now stub Anthropic to return fresh tokens for the proactive refresh.
    __setAnthropicFetch((() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'sk-ant-oat01-NEW',
            refresh_token: 'sk-ant-ort01-NEW',
            expires_in: 28800,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )) as typeof fetch)

    // Run the cron action — should fan over all active subs and refresh.
    await t.action(internal.subscriptions.crons.refreshExpiringSubs, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    // Pull the sub and assert the access token was rotated to the new one.
    const pulled = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'refresh@example.com',
    })
    const blob = JSON.parse(pulled.plaintextBlob) as {
      claudeAiOauth: { accessToken: string; refreshToken: string }
    }
    expect(blob.claudeAiOauth.accessToken).toBe('sk-ant-oat01-NEW')
  })

  it('does NOT refresh a sub that is far from expiry (no storm, no needless rotation)', async () => {
    const t = vault()
    await seedUser(t)

    // expiresAt 8h out — well OUTSIDE REFRESH_PROACTIVE_MS, so refreshOAuthToken
    // must acquire the lease, see the token is fresh, and bail without hitting
    // Anthropic. This is the safety property that makes fanning the cron over
    // ALL subs cheap.
    const farExpiryAt = Date.now() + 8 * 60 * 60 * 1000
    const BLOB = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-KEEP-AAAAAAAAAAAAAAAAAAAAAAAA',
        refreshToken: 'sk-ant-ort01-KEEP-BBBBBBBBBBBBBBBBBBBBBBBB',
        expiresAt: farExpiryAt,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
      config: { oauthAccount: { emailAddress: 'fresh@example.com' } },
    })

    __setAnthropicFetch((() => Promise.resolve(new Response('rate-limited', { status: 429 }))) as typeof fetch)
    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'fresh@example.com',
      plaintextBlob: BLOB,
      expiresAt: farExpiryAt,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    // If the cron WRONGLY refreshed, it would rotate to this token. It must not.
    __setAnthropicFetch((() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ access_token: 'sk-ant-oat01-SHOULD-NOT-APPEAR', refresh_token: 'x', expires_in: 28800 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )) as typeof fetch)

    await t.action(internal.subscriptions.crons.refreshExpiringSubs, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const pulled = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'fresh@example.com',
    })
    const blob = JSON.parse(pulled.plaintextBlob) as { claudeAiOauth: { accessToken: string } }
    expect(blob.claudeAiOauth.accessToken).toBe('sk-ant-oat01-KEEP-AAAAAAAAAAAAAAAAAAAAAAAA')
  })
})
