/**
 * Spec: §5 (fetchUsageForSub action) + §10 (errors).
 *
 * Behavior covered:
 *  - 200: usage5h + usage7d patched onto the sub row
 *  - 429: skipped silently (no-op, no usage patched)
 *  - missing/skipped values in the response are tolerated
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { __setAnthropicFetch } from './anthropic'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 11).toString('base64')
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.VAULT_AES_KEY
  } else {
    process.env.VAULT_AES_KEY = ORIGINAL_KEY
  }
  __setAnthropicFetch(undefined)
})

async function seedSubscription(t: ReturnType<typeof vault>) {
  await seedUser(t)
  const { encrypt } = await import('./crypto')
  const plaintext = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-USAGE-EEEEEEEEEEEEEEEEEEEEEEEEE',
      refreshToken: 'sk-ant-ort01-USAGE-FFFFFFFFFFFFFFFFFFFFFFFFF',
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ['user:inference'],
    },
  })
  const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
  return await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
    email: 'usage@example.com',
    ciphertext,
    nonce,
    keyVersion,
    expiresAt: Date.now() + 60 * 60 * 1000,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
  })
}

describe('subscriptions.actions.fetchUsageForSub', () => {
  it('patches usage5h and usage7d when Anthropic returns 200', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    const futureFiveHour = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    const futureSevenDay = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString()
    __setAnthropicFetch(
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              five_hour: { utilization: 23.5, resets_at: futureFiveHour },
              seven_day: { utilization: 47.0, resets_at: futureSevenDay },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      )
    )

    await t.action(internal.subscriptions.actions.fetchUsageForSub, { subId: inserted.subId })

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.usage5h?.pct).toBe(23.5)
    expect(after?.usage7d?.pct).toBe(47.0)
    expect(after?.usage5h?.resetsAt).toBe(new Date(futureFiveHour).getTime())
    expect(after?.usage7d?.resetsAt).toBe(new Date(futureSevenDay).getTime())
  })

  it('silently skips when Anthropic returns 429', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    __setAnthropicFetch(vi.fn(() => Promise.resolve(new Response('Rate Limited', { status: 429 }))))

    await t.action(internal.subscriptions.actions.fetchUsageForSub, { subId: inserted.subId })

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.usage5h).toBeUndefined()
    expect(after?.usage7d).toBeUndefined()
  })

  it('handles a partial response (only five_hour present)', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    __setAnthropicFetch(
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ five_hour: { utilization: 5, resets_at: future } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      )
    )

    await t.action(internal.subscriptions.actions.fetchUsageForSub, { subId: inserted.subId })

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.usage5h?.pct).toBe(5)
    expect(after?.usage7d).toBeUndefined()
  })

  // Regression: prod incident where every sub's 5h bar froze at "resets now".
  // When a 5h window crosses its reset, Anthropic stops returning a usable
  // `five_hour` while still returning `seven_day`. The window that is ABSENT
  // from a *successful* response must be CLEARED, not retained — otherwise the
  // dead `{pct, resetsAt}` lingers forever (e.g. "99% resets now") while the
  // 7d window keeps updating on every 5-minute poll.
  it('clears a previously-set window that is absent from a successful response', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    // Simulate the last successful poll having stored a now-expired 5h window
    // and a healthy 7d window.
    const stale5h = { pct: 99, resetsAt: Date.now() - 60 * 1000, fetchedAt: Date.now() - 60 * 1000 }
    await t.run(async (ctx) => {
      await ctx.db.patch('subscriptions', inserted.subId, {
        usage5h: stale5h,
        usage7d: { pct: 50, resetsAt: Date.now() + 24 * 60 * 60 * 1000, fetchedAt: Date.now() - 60 * 1000 },
      })
    })

    const futureSevenDay = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString()
    __setAnthropicFetch(
      vi.fn(() =>
        Promise.resolve(
          // Successful poll, but the 5h window has reset and is no longer present.
          new Response(JSON.stringify({ seven_day: { utilization: 51, resets_at: futureSevenDay } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      )
    )

    await t.action(internal.subscriptions.actions.fetchUsageForSub, { subId: inserted.subId })

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.usage5h).toBeUndefined()
    expect(after?.usage7d?.pct).toBe(51)
    expect(after?.usage7d?.resetsAt).toBe(new Date(futureSevenDay).getTime())
  })

  // Counterpart to the above: a *failed* fetch (429/401/5xx/network) must
  // preserve the last-known windows — we never invent or erase on failure.
  it('preserves last-known windows when the fetch fails (429)', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    const known5h = { pct: 42, resetsAt: Date.now() + 60 * 60 * 1000, fetchedAt: Date.now() - 60 * 1000 }
    const known7d = { pct: 50, resetsAt: Date.now() + 24 * 60 * 60 * 1000, fetchedAt: Date.now() - 60 * 1000 }
    await t.run(async (ctx) => {
      await ctx.db.patch('subscriptions', inserted.subId, { usage5h: known5h, usage7d: known7d })
    })

    __setAnthropicFetch(vi.fn(() => Promise.resolve(new Response('Rate Limited', { status: 429 }))))

    await t.action(internal.subscriptions.actions.fetchUsageForSub, { subId: inserted.subId })

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.usage5h).toEqual(known5h)
    expect(after?.usage7d).toEqual(known7d)
  })
})
