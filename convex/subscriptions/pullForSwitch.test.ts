import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import { NEUTERED_REFRESH_TOKEN } from './actions'
import { __setAnthropicFetch } from './anthropic'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

const BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-REAL-AAAAAAAAAAAAAAAAAAAA',
    refreshToken: 'sk-ant-ort01-REAL-BBBBBBBBBBBBBBBBBBBB',
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
  config: { oauthAccount: { emailAddress: 'a@b.com' } },
})

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 13).toString('base64')
  __setAnthropicFetch((() => Promise.resolve(new Response('rl', { status: 429 }))) as typeof fetch)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  __setAnthropicFetch(undefined)
  if (ORIGINAL_KEY === undefined) delete process.env.VAULT_AES_KEY
  else process.env.VAULT_AES_KEY = ORIGINAL_KEY
})

describe('pullForSwitch neuterRefreshToken', () => {
  it('replaces the refresh token with the sentinel when neuterRefreshToken is true', async () => {
    const t = vault()
    await seedUser(t)
    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'a@b.com',
      plaintextBlob: BLOB,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const pulled = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'a@b.com',
      neuterRefreshToken: true,
    })
    const blob = JSON.parse(pulled.plaintextBlob) as { claudeAiOauth: { refreshToken: string; accessToken: string } }
    expect(blob.claudeAiOauth.refreshToken).toBe(NEUTERED_REFRESH_TOKEN)
    expect(blob.claudeAiOauth.accessToken).toBe('sk-ant-oat01-REAL-AAAAAAAAAAAAAAAAAAAA')
  })

  it('returns the real refresh token when the flag is absent (back-compat)', async () => {
    const t = vault()
    await seedUser(t)
    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'a@b.com',
      plaintextBlob: BLOB,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const pulled = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'a@b.com',
    })
    const blob = JSON.parse(pulled.plaintextBlob) as { claudeAiOauth: { refreshToken: string } }
    expect(blob.claudeAiOauth.refreshToken).toBe('sk-ant-ort01-REAL-BBBBBBBBBBBBBBBBBBBB')
  })
})
