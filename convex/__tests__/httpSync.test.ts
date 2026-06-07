/**
 * Spec: §5 (HTTP) + §7 (`cvault sync --all`).
 *
 * GET /api/cli/sync — bundle endpoint that returns plaintext for every
 * active sub belonging to the caller. The CLI uses this on a fresh
 * machine to bootstrap the local Keychain in one round-trip.
 *
 * Auth: caller must present `Authorization: Bearer <convexJwt>`. Convex
 * verifies the JWT against the `convex` Clerk template's JWKS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { __setAnthropicFetch } from '../subscriptions/anthropic'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 23).toString('base64')
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.VAULT_AES_KEY
  } else {
    process.env.VAULT_AES_KEY = ORIGINAL_KEY
  }
  __setAnthropicFetch(undefined)
})

describe('GET /api/cli/sync', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const t = vault()
    const resp = await t.fetch('/api/cli/sync')
    expect(resp.status).toBe(401)
  })

  it('returns 403 for a banned user (revokedUsers sub-denylist) — does not leak the bundle', async () => {
    const t = vault()
    await seedUser(t)
    await t.mutation(internal.revokedUsers.mutations.ban, { externalId: TEST_IDENTITY.subject, at: Date.now() })

    const resp = await t.withIdentity(TEST_IDENTITY).fetch('/api/cli/sync')
    expect(resp.status).toBe(403)
    const body = (await resp.json()) as { error?: string }
    expect(body.error).toMatch(/revoked/i)
  })

  it('returns 403 for a revoked device (revokedSessions sid-denylist)', async () => {
    const t = vault()
    await seedUser(t)
    await t.mutation(internal.revokedSessions.mutations.revoke, { sid: 'sess_revoked_cli', at: Date.now() })

    // The CLI authenticates Convex with the OIDC id-token, which carries `sid`.
    const resp = await t.withIdentity({ ...TEST_IDENTITY, sid: 'sess_revoked_cli' }).fetch('/api/cli/sync')
    expect(resp.status).toBe(403)
  })

  it("returns the caller's active subs as plaintext bundle when authenticated", async () => {
    const t = vault()
    await seedUser(t)

    // Seed two encrypted subs via the public upsert mutation.
    const { encrypt } = await import('../subscriptions/crypto')

    const blobA = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-AAAA-aaaaaaaaaaaaaaaaaaaaaa',
        refreshToken: 'sk-ant-ort01-AAAA-aaaaaaaaaaaaaaaaaaaaaa',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
      },
    })
    const blobB = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-BBBB-bbbbbbbbbbbbbbbbbbbbbb',
        refreshToken: 'sk-ant-ort01-BBBB-bbbbbbbbbbbbbbbbbbbbbb',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
      },
    })

    const cipherA = encrypt(blobA)
    const cipherB = encrypt(blobB)

    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'a@example.com',
      ciphertext: cipherA.ciphertext,
      nonce: cipherA.nonce,
      keyVersion: cipherA.keyVersion,
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'b@example.com',
      ciphertext: cipherB.ciphertext,
      nonce: cipherB.nonce,
      keyVersion: cipherB.keyVersion,
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // Anthropic may be hit by proactive refresh; stub to a no-op success
    // so the action never fails (subs aren't actually expiring).
    __setAnthropicFetch(
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ access_token: 'X', expires_in: 3600 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      )
    )

    const tWithAuth = t.withIdentity(TEST_IDENTITY)
    const resp = await tWithAuth.fetch('/api/cli/sync')
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as {
      subs: Array<{ email: string; slot: number; plaintextBlob: string; contentHash: string }>
    }
    expect(body.subs).toHaveLength(2)
    const emails = body.subs.map((s) => s.email).sort()
    expect(emails).toEqual(['a@example.com', 'b@example.com'])
    // Plaintext is included so the CLI can rehydrate the Keychain.
    expect(body.subs[0]?.plaintextBlob).toContain('claudeAiOauth')
    expect(body.subs[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("inserts a machineActivity row with action='pull' when the bulk sync runs", async () => {
    const t = vault()
    await seedUser(t)
    const { encrypt } = await import('../subscriptions/crypto')
    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-AUDIT-XXXXXXXXXXXXXXXXXXXX',
        refreshToken: 'sk-ant-ort01-AUDIT-YYYYYYYYYYYYYYYYYYYY',
        expiresAt: Date.now() + 60_000,
      },
    })
    const c = encrypt(blob)
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'audit@example.com',
      ciphertext: c.ciphertext,
      nonce: c.nonce,
      keyVersion: c.keyVersion,
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    const resp = await t.withIdentity(TEST_IDENTITY).fetch('/api/cli/sync', {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    })
    expect(resp.status).toBe(200)

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    // Bulk-pull is currently logged as a single 'pull' row per call.
    const pullRow = rows.find((r) => r.action === 'pull')
    expect(pullRow).toBeDefined()
    // The forwarded-for IP should have been hashed to a non-empty 8-char prefix.
    expect(pullRow?.ipHash).toBeDefined()
    expect(pullRow?.ipHash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('returns 429 once the per-user rate limit is exceeded', async () => {
    const t = vault()
    await seedUser(t)
    // Seed one sub so the bundle has something to return — though the
    // rate limiter runs BEFORE the bundle build either way.
    const { encrypt } = await import('../subscriptions/crypto')
    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-RL-AAAAAAAAAAAAAAAAAAAAA',
        refreshToken: 'sk-ant-ort01-RL-BBBBBBBBBBBBBBBBBBBBB',
        expiresAt: Date.now() + 60_000,
      },
    })
    const c = encrypt(blob)
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'rl@example.com',
      ciphertext: c.ciphertext,
      nonce: c.nonce,
      keyVersion: c.keyVersion,
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // Limit is 10 syncs / hour / user. Spam 10 — they should all succeed.
    for (let i = 0; i < 10; i += 1) {
      const r = await t.withIdentity(TEST_IDENTITY).fetch('/api/cli/sync')
      expect(r.status).toBe(200)
    }

    // 11th should be rate-limited.
    const limited = await t.withIdentity(TEST_IDENTITY).fetch('/api/cli/sync')
    expect(limited.status).toBe(429)
    const body = (await limited.json()) as { error?: string; retryAfterMs?: number }
    expect(body.error).toMatch(/rate.?limit|too.?many/i)
    expect(body.retryAfterMs).toBeTypeOf('number')
  })

  it('omits soft-removed subs from the bundle', async () => {
    const t = vault()
    await seedUser(t)
    const { encrypt } = await import('../subscriptions/crypto')

    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-CCC-cccccccccccccccccccccccc',
        refreshToken: 'sk-ant-ort01-CCC-cccccccccccccccccccccccc',
        expiresAt: Date.now() + 60_000,
      },
    })
    const c = encrypt(blob)
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'gone@example.com',
      ciphertext: c.ciphertext,
      nonce: c.nonce,
      keyVersion: c.keyVersion,
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'gone@example.com',
    })

    const resp = await t.withIdentity(TEST_IDENTITY).fetch('/api/cli/sync')
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { subs: Array<unknown> }
    expect(body.subs).toHaveLength(0)
  })
})
