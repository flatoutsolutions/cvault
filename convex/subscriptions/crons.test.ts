/**
 * Spec: §5 (crons) + §11 (testing).
 *
 * Tests the internal "cron worker" actions that get scheduled. We don't
 * test the convex/server `cronJobs()` schedule itself — that's just config.
 *
 * The `refreshExpiringTokens` cron was removed in v1 (audit fix #5):
 * see `convex/__tests__/scenarios/cronDoesNotPoisonStaleRT.scenario.test.ts`
 * for the rationale and the regression guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { __setAnthropicFetch } from './anthropic'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 17).toString('base64')
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.VAULT_AES_KEY
  } else {
    process.env.VAULT_AES_KEY = ORIGINAL_KEY
  }
  __setAnthropicFetch(undefined)
})

async function seedActiveSub(t: ReturnType<typeof vault>, expiresAt: number) {
  await seedUser(t)
  const { encrypt } = await import('./crypto')
  const plaintext = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-CRON-AAAAAAAAAAAAAAAAAAAAAAAA',
      refreshToken: 'sk-ant-ort01-CRON-BBBBBBBBBBBBBBBBBBBBBBBB',
      expiresAt,
      scopes: ['user:inference'],
    },
  })
  const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
  return await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
    email: 'expiring@example.com',
    ciphertext,
    nonce,
    keyVersion,
    expiresAt,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
  })
}

describe('subscriptions.crons.pollUsage', () => {
  it('fans out fetchUsageForSub for every active sub', async () => {
    const t = vault()
    const inserted = await seedActiveSub(t, Date.now() + 60 * 60 * 1000)

    const future = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    const fetchStub = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: future } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    )
    __setAnthropicFetch(fetchStub)

    await t.action(internal.subscriptions.crons.pollUsage, {})

    expect(fetchStub).toHaveBeenCalledTimes(1)
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.usage5h).toMatchObject({ pct: 12 })
  })

  it('skips removed subs', async () => {
    const t = vault()
    await seedActiveSub(t, Date.now() + 60 * 60 * 1000)
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'expiring@example.com',
    })

    const fetchStub = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
    __setAnthropicFetch(fetchStub)

    await t.action(internal.subscriptions.crons.pollUsage, {})

    expect(fetchStub).not.toHaveBeenCalled()
  })
})
