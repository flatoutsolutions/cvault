/**
 * Spec: §5 (crons) + §11 (testing).
 *
 * Tests the internal "cron worker" actions that get scheduled. We don't
 * test the convex/server `cronJobs()` schedule itself — that's just config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from '../_generated/api'
import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
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

async function seedExpiringSub(t: ReturnType<typeof vault>, expiresAt: number) {
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
  const { ciphertext, nonce } = encrypt(plaintext)
  return await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
    email: 'expiring@example.com',
    ciphertext,
    nonce,
    expiresAt,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
  })
}

describe('subscriptions.crons.refreshExpiringTokens', () => {
  it('schedules a refresh for subs expiring within the window', async () => {
    const t = vault()
    const soon = Date.now() + 5 * 60 * 1000 // 5 min from now
    const inserted = await seedExpiringSub(t, soon)

    __setAnthropicFetch(
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'sk-ant-oat01-NEW-CCCCCCCCCCCCCCCCCCCCC',
              refresh_token: 'sk-ant-ort01-NEW-DDDDDDDDDDDDDDDDDDDDD',
              expires_in: 28_800,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      )
    )

    await t.action(internal.subscriptions.crons.refreshExpiringTokens, {})

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)

    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(1)
    expect(logs[0]?.triggeredBy).toBe('cron')
  })

  it('skips subs whose access token is still valid for > window', async () => {
    const t = vault()
    const farFuture = Date.now() + 60 * 60 * 1000 // 1 hour out
    const inserted = await seedExpiringSub(t, farFuture)

    const fetchStub = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
    __setAnthropicFetch(fetchStub)

    await t.action(internal.subscriptions.crons.refreshExpiringTokens, {})

    expect(fetchStub).not.toHaveBeenCalled()
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.expiresAt).toBe(farFuture)
  })

  it('ignores soft-removed subs even if expiring', async () => {
    const t = vault()
    const soon = Date.now() + 1_000
    const inserted = await seedExpiringSub(t, soon)

    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'expiring@example.com',
    })

    const fetchStub = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
    __setAnthropicFetch(fetchStub)

    await t.action(internal.subscriptions.crons.refreshExpiringTokens, {})

    expect(fetchStub).not.toHaveBeenCalled()
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.removedAt).toBeTypeOf('number')
  })
})

describe('subscriptions.crons.refreshExpiringTokens — fanout resilience', () => {
  it('continues processing other subs when one sub throws (Promise.allSettled semantics)', async () => {
    const t = vault()
    await seedUser(t)

    // Seed three expiring subs.
    const { encrypt } = await import('./crypto')
    async function seedOne(email: string) {
      const expiresAt = Date.now() + 60_000 // within window
      const plaintext = JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-' + email + '-' + 'A'.repeat(20),
          refreshToken: 'sk-ant-ort01-' + email + '-' + 'B'.repeat(20),
          expiresAt,
          scopes: ['user:inference'],
        },
      })
      const { ciphertext, nonce } = encrypt(plaintext)
      const r = await t.withIdentity(TEST_IDENTITY).mutation(
        api.subscriptions.mutations.upsert,
        {
          email,
          ciphertext,
          nonce,
          expiresAt,
          subscriptionType: 'max',
          rateLimitTier: 'tier1',
        }
      )
      return r.subId
    }
    const idA = await seedOne('a@example.com')
    const idB = await seedOne('b@example.com')
    const idC = await seedOne('c@example.com')

    // Tamper sub B so its decrypt throws inside refreshOAuthToken (the
    // action will then release the lease and log a failure row, but we
    // verify here that the whole cron run does NOT abort because of it).
    await t.run(async (ctx) => {
      const sub = await ctx.db.get('subscriptions', idB)
      if (!sub) throw new Error('seed missing')
      const ct = new Uint8Array(sub.ciphertext)
      ct[0] = (ct[0] ?? 0) ^ 0xff
      await ctx.db.patch('subscriptions', idB, { ciphertext: ct.buffer })
    })

    // Anthropic returns 200 — A and C will succeed, B will fail at the
    // decrypt step before any HTTP call.
    let calls = 0
    __setAnthropicFetch(
      vi.fn(() => {
        calls += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'sk-ant-oat01-NEW-' + 'X'.repeat(20),
              refresh_token: 'sk-ant-ort01-NEW-' + 'Y'.repeat(20),
              expires_in: 28_800,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      })
    )

    // The whole cron MUST NOT throw — it should return null normally
    // even though one sub failed to decrypt.
    await t.action(internal.subscriptions.crons.refreshExpiringTokens, {})

    // Two Anthropic calls (A + C); B never reached the HTTP step.
    expect(calls).toBe(2)

    // A and C have new ciphertext and refreshLog success rows.
    const after = await t.run(async (ctx) => {
      return {
        a: await ctx.db.get('subscriptions', idA),
        b: await ctx.db.get('subscriptions', idB),
        c: await ctx.db.get('subscriptions', idC),
      }
    })
    expect(after.a?.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
    expect(after.c?.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)

    // B's lease was released by the decrypt-failure path.
    expect(after.b?.refreshLeaseHolder).toBeUndefined()

    // Logs: one failure (B), two successes (A, C).
    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    const failures = logs.filter((l) => l.outcome === 'failure')
    const successes = logs.filter((l) => l.outcome === 'success')
    expect(failures).toHaveLength(1)
    expect(failures[0]?.subscriptionId).toEqual(idB)
    expect(successes).toHaveLength(2)
  })
})

describe('subscriptions.crons.pollUsage', () => {
  it('fans out fetchUsageForSub for every active sub', async () => {
    const t = vault()
    const inserted = await seedExpiringSub(t, Date.now() + 60 * 60 * 1000)

    const future = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    const fetchStub = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ five_hour: { utilization: 12, resets_at: future } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    )
    __setAnthropicFetch(fetchStub)

    await t.action(internal.subscriptions.crons.pollUsage, {})

    expect(fetchStub).toHaveBeenCalledTimes(1)
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.usage5h?.pct).toBe(12)
  })

  it('skips removed subs', async () => {
    const t = vault()
    await seedExpiringSub(t, Date.now() + 60 * 60 * 1000)
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'expiring@example.com',
    })

    const fetchStub = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
    __setAnthropicFetch(fetchStub)

    await t.action(internal.subscriptions.crons.pollUsage, {})

    expect(fetchStub).not.toHaveBeenCalled()
  })
})
