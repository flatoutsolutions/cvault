/**
 * Spec: §5 (refreshOAuthToken action) + §9 (race protection) + §10 (errors).
 *
 * The refresh action POSTs to Anthropic's OAuth token endpoint and rotates
 * the encrypted credential blob in place. We test it against a mocked
 * fetch via the injectable `_internalFetch` test seam.
 *
 * Behaviors covered:
 *  - 200 success: ciphertext rotated, expiresAt advanced, log.outcome=success
 *  - 401 (refresh token dead): refreshExpiresAt clamped, log.outcome=reloginRequired
 *  - 500 (transient): log.outcome=failure, lease released for next cron tick
 *  - lease lost (someone else holds): aborts cleanly, no log row inserted
 *  - error message containing OAuth token shape: redacted before log insert
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { __setAnthropicFetch, __setRandomBytesForTest } from './anthropic'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 9).toString('base64')
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.VAULT_AES_KEY
  } else {
    process.env.VAULT_AES_KEY = ORIGINAL_KEY
  }
  __setAnthropicFetch(undefined)
  __setRandomBytesForTest(undefined)
})

interface FakeFetchOptions {
  status?: number
  body?: unknown
}

function makeFetchStub({ status = 200, body }: FakeFetchOptions) {
  return vi.fn(() => {
    return Promise.resolve(
      new Response(JSON.stringify(body ?? {}), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  })
}

async function seedSubscription(t: ReturnType<typeof vault>) {
  await seedUser(t)
  // Seed an encrypted blob via the public upsert mutation. This requires
  // a *real* ciphertext+nonce we can later decrypt inside the action.
  const { encrypt } = await import('./crypto')
  const plaintext = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-INITIAL-AAAAAAAAAAAAAAAAAAAAAAAAA',
      refreshToken: 'sk-ant-ort01-INITIAL-BBBBBBBBBBBBBBBBBBBBBBBBB',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
    },
  })
  const { ciphertext, nonce } = encrypt(plaintext)

  return await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
    email: 'rotate@example.com',
    ciphertext,
    nonce,
    expiresAt: Date.now() + 60_000,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
  })
}

describe('subscriptions.actions.refreshOAuthToken', () => {
  it('rotates ciphertext, advances expiresAt, and logs success on 200', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    const fetchStub = makeFetchStub({
      status: 200,
      body: {
        access_token: 'sk-ant-oat01-NEW-CCCCCCCCCCCCCCCCCCCCCCCCC',
        refresh_token: 'sk-ant-ort01-NEW-DDDDDDDDDDDDDDDDDDDDDDDDD',
        expires_in: 28_800,
        scope: 'user:inference',
      },
    })
    __setAnthropicFetch(fetchStub)

    const before = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    const beforeCtHex = Buffer.from(before?.ciphertext ?? new ArrayBuffer(0)).toString('hex')

    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: inserted.subId,
      triggeredBy: 'manual',
    })

    expect(fetchStub).toHaveBeenCalledTimes(1)

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
    // ciphertext changed (it's a fresh encrypt with fresh nonce + new plaintext)
    const afterCtHex = Buffer.from(after?.ciphertext ?? new ArrayBuffer(0)).toString('hex')
    expect(afterCtHex).not.toBe(beforeCtHex)
    // Lease released.
    expect(after?.refreshLeaseHolder).toBeUndefined()

    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('success')
    expect(logs[0]?.subscriptionId).toEqual(inserted.subId)
    expect(logs[0]?.triggeredBy).toBe('manual')
  })

  it('marks reloginRequired when Anthropic returns 401', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    __setAnthropicFetch(
      makeFetchStub({
        status: 401,
        body: { error: 'invalid_grant', error_description: 'refresh token expired' },
      })
    )

    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: inserted.subId,
      triggeredBy: 'cron',
    })

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.refreshExpiresAt).toBeLessThanOrEqual(Date.now())
    expect(after?.refreshLeaseHolder).toBeUndefined()

    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('reloginRequired')
  })

  it('logs failure but does not clamp refreshExpiresAt on 500', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)
    const before = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))

    __setAnthropicFetch(makeFetchStub({ status: 503, body: { error: 'service_unavailable' } }))

    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: inserted.subId,
      triggeredBy: 'cron',
    })

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    // refreshExpiresAt left untouched (stays as before).
    expect(after?.refreshExpiresAt).toBe(before?.refreshExpiresAt)
    // Lease released so next cron tick can retry.
    expect(after?.refreshLeaseHolder).toBeUndefined()

    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('failure')
  })

  it('aborts without inserting a log row when the lease is held by someone else', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    // Pre-seize the lease for another holder.
    await t.run(async (ctx) => {
      await ctx.db.patch('subscriptions', inserted.subId, {
        refreshLeaseHolder: 'other-machine',
        refreshLeaseUntil: Date.now() + 30_000,
      })
    })

    __setAnthropicFetch(makeFetchStub({ status: 200, body: { access_token: 'X' } }))

    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: inserted.subId,
      triggeredBy: 'cron',
    })

    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(0)

    // The other holder's lease should still be there.
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.refreshLeaseHolder).toBe('other-machine')
  })

  it('rejects requestRefresh from an unauthenticated caller', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)
    await expect(t.action(api.subscriptions.actions.requestRefresh, { subId: inserted.subId })).rejects.toThrow(
      /authenticated/i
    )
  })

  it('rejects requestRefresh when the caller does not own the sub', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)
    // Bob (a different identity) tries to refresh Alice's sub.
    const bob = {
      subject: 'user_test_bob',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_bob',
      name: 'Bob',
      email: 'bob@example.com',
    }
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: bob.subject,
        name: bob.name,
        primaryEmail: bob.email,
        otherEmails: [],
      })
    })
    await expect(
      t.withIdentity(bob).action(api.subscriptions.actions.requestRefresh, {
        subId: inserted.subId,
      })
    ).rejects.toThrow(/not found|not owned/i)
  })

  it("requestRefresh inserts a machineActivity row with action='refresh' on success", async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    __setAnthropicFetch(
      makeFetchStub({
        status: 200,
        body: {
          access_token: 'sk-ant-oat01-AUDIT-RRRRRRRRRRRRRRRRRRRR',
          refresh_token: 'sk-ant-ort01-AUDIT-SSSSSSSSSSSSSSSSSSSS',
          expires_in: 28_800,
        },
      })
    )

    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.requestRefresh, {
      subId: inserted.subId,
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const refreshRow = rows.find((r) => r.action === 'refresh')
    expect(refreshRow).toBeDefined()
    expect(refreshRow?.subscriptionId).toEqual(inserted.subId)
  })

  it('requestRefresh succeeds and runs the manual refresh cycle', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    __setAnthropicFetch(
      makeFetchStub({
        status: 200,
        body: {
          access_token: 'sk-ant-oat01-MANUAL-RRRRRRRRRRRRRRRRRRRR',
          refresh_token: 'sk-ant-ort01-MANUAL-SSSSSSSSSSSSSSSSSSSS',
          expires_in: 28_800,
        },
      })
    )

    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.requestRefresh, {
      subId: inserted.subId,
    })

    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('success')
    expect(logs[0]?.triggeredBy).toBe('manual')
  })

  it('pullForSwitch throws REFRESH_FAILED instead of returning stale plaintext when proactive refresh fails', async () => {
    const t = vault()
    // Seed a sub that's already past its access-token expiry (so the
    // proactive refresh inside pullForSwitch will run).
    await seedUser(t)
    const { encrypt } = await import('./crypto')
    const expiredAt = Date.now() - 60_000 // already expired
    const plaintext = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-STALE-AAAAAAAAAAAAAAAAAAAA',
        refreshToken: 'sk-ant-ort01-STALE-BBBBBBBBBBBBBBBBBBBB',
        expiresAt: expiredAt,
        scopes: ['user:inference'],
      },
    })
    const { ciphertext, nonce } = encrypt(plaintext)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'stale@example.com',
      ciphertext,
      nonce,
      expiresAt: expiredAt,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // Anthropic returns 503 — refresh fails transiently.
    __setAnthropicFetch(makeFetchStub({ status: 503, body: { error: 'service_unavailable' } }))

    // pullForSwitch must NOT return the stale plaintext to the CLI; it
    // should throw a REFRESH_FAILED-shaped error so the CLI can surface
    // "refresh failed — try `cvault refresh` manually" instead of
    // silently handing the user a token that's about to fail at Anthropic.
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, {
        slotOrEmail: 'stale@example.com',
      })
    ).rejects.toThrow(/refresh.*fail|expired/i)

    // Sanity: the sub row's expiresAt was NOT advanced (refresh failed),
    // and the refreshLog has a failure row for the onUse trigger.
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.expiresAt).toBe(expiredAt)
    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs.some((l) => l.outcome === 'failure' && l.triggeredBy === 'onUse')).toBe(true)
  })

  it('releases the lease and logs failure when decrypt throws on tampered ciphertext', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    // Tamper the ciphertext (flip one byte) so the GCM auth tag check
    // fails when the action tries to decrypt.
    await t.run(async (ctx) => {
      const sub = await ctx.db.get('subscriptions', inserted.subId)
      if (!sub) throw new Error('sub disappeared in test setup')
      const ct = new Uint8Array(sub.ciphertext)
      // XOR the first byte to make it mismatch the auth tag.
      ct[0] = (ct[0] ?? 0) ^ 0xff
      await ctx.db.patch('subscriptions', inserted.subId, { ciphertext: ct.buffer })
    })

    // Anthropic shouldn't be touched; if it were, that would be a bug.
    const fetchStub = makeFetchStub({ status: 200, body: { access_token: 'X' } })
    __setAnthropicFetch(fetchStub)

    // The action MUST handle the decrypt throw gracefully — release the
    // lease, log a failure row, return null. (Today it lets the throw
    // propagate, which leaves the lease held for the full 30s TTL.)
    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: inserted.subId,
      triggeredBy: 'cron',
    })

    // Anthropic was NEVER called (decrypt failed before any HTTP work).
    expect(fetchStub).not.toHaveBeenCalled()

    // The lease MUST be released so subsequent attempts don't have to
    // wait 30 seconds.
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.refreshLeaseHolder).toBeUndefined()
    expect(after?.refreshLeaseUntil).toBeUndefined()

    // A failure row MUST be inserted so the dashboard / CLI sees the
    // creds-corrupt signal. Per spec §10: "Decrypt failure (GCM auth
    // tag) → Throw, log error w/ subId; surface as 'creds corrupt — re-add'".
    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('failure')
    expect(logs[0]?.error).toBeTruthy()
    // Error message is human-readable and mentions corruption / decrypt.
    expect(logs[0]?.error ?? '').toMatch(/corrupt|decrypt/i)
    // CRITICAL: the persisted error contains no OAuth-token-shaped
    // substrings even though the decrypt throw could include a stack
    // referencing the input.
    expect(logs[0]?.error ?? '').not.toMatch(/sk-ant-oat01|sk-ant-ort01/)
  })

  it('subsequent refresh acquires the lease immediately after a decrypt failure released it', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    // Tamper the ciphertext.
    await t.run(async (ctx) => {
      const sub = await ctx.db.get('subscriptions', inserted.subId)
      if (!sub) throw new Error('sub disappeared in test setup')
      const ct = new Uint8Array(sub.ciphertext)
      ct[0] = (ct[0] ?? 0) ^ 0xff
      await ctx.db.patch('subscriptions', inserted.subId, { ciphertext: ct.buffer })
    })

    __setAnthropicFetch(makeFetchStub({ status: 200, body: { access_token: 'X' } }))

    // First call fails decrypt and releases the lease.
    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: inserted.subId,
      triggeredBy: 'cron',
    })

    // Try to acquire the lease right away — it must succeed (no 30s TTL wait).
    const acq = await t.mutation(internal.subscriptions.mutations.tryAcquireRefreshLease, {
      subId: inserted.subId,
      holderToken: 'next-attempt',
    })
    expect(acq.acquired).toBe(true)
  })

  /**
   * Cron spam guard: a sub whose `refreshExpiresAt <= now` was already
   * marked dead (a prior refresh got `invalid_grant` from Anthropic).
   * The action MUST NOT re-drive Anthropic in that state — every cron
   * tick would otherwise burn an API call and log a fresh
   * `reloginRequired` row. The cron-side `findExpiringSubs` filter is
   * the primary defense; this is the defense-in-depth re-check inside
   * the action so manual `cvault refresh` calls and any future caller
   * also short-circuit cleanly.
   */
  it('short-circuits when refreshExpiresAt <= now (no Anthropic call, no spurious log)', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    // Mark the sub as RT-dead by clamping refreshExpiresAt into the past.
    // Mirrors what `markReloginRequired` does after a real `invalid_grant`.
    await t.run(async (ctx) => {
      await ctx.db.patch('subscriptions', inserted.subId, {
        refreshExpiresAt: Date.now() - 60_000,
      })
    })

    // If the action reaches Anthropic, this is a bug — the test would
    // observe a fetchStub call, which we explicitly assert does NOT
    // happen.
    const fetchStub = makeFetchStub({ status: 200, body: { access_token: 'X' } })
    __setAnthropicFetch(fetchStub)

    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: inserted.subId,
      triggeredBy: 'cron',
    })

    expect(fetchStub).not.toHaveBeenCalled()

    // The lease MUST be released so a later user-driven `cvault add`
    // (which writes through `upsertEncrypted`, not the lease path)
    // doesn't have to wait 30 seconds.
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.refreshLeaseHolder).toBeUndefined()
    expect(after?.refreshLeaseUntil).toBeUndefined()

    // No log row inserted — the original `reloginRequired` row from the
    // refresh that first marked the sub dead is enough; further rows
    // are noise.
    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(0)
  })

  /**
   * Machine label propagation: every public action that records to
   * machineActivity accepts an optional `machineLabel` and forwards it
   * to the audit row. The dashboard's "Machines" section reads the
   * most-recent label per Clerk session as the user-visible identifier.
   * Without this pass-through, the dashboard would only ever show
   * `(no label)` even though the CLI knows the hostname.
   */
  it('pullForSwitch forwards machineLabel to the machineActivity row', async () => {
    const t = vault()
    await seedUser(t)
    const { encrypt } = await import('./crypto')
    // Fresh token so the proactive refresh inside pullForSwitch is a no-op.
    const futureExpiry = Date.now() + 60 * 60 * 1000
    const plaintext = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-FRESH-AAAAAAAAAAAAAAAAAAAA',
        refreshToken: 'sk-ant-ort01-FRESH-BBBBBBBBBBBBBBBBBBBB',
        expiresAt: futureExpiry,
        scopes: ['user:inference'],
      },
    })
    const { ciphertext, nonce } = encrypt(plaintext)
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'label-pull@example.com',
      ciphertext,
      nonce,
      expiresAt: futureExpiry,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'label-pull@example.com',
      machineLabel: 'air-13-stefan',
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const pullRow = rows.find((r) => r.action === 'pull')
    expect(pullRow?.machineLabel).toBe('air-13-stefan')
  })

  it('redacts OAuth-token-shaped substrings from the error log', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)

    // Anthropic returns a 401 with a body that echoes the bad refresh token.
    __setAnthropicFetch(
      makeFetchStub({
        status: 401,
        body: {
          error: 'invalid_grant',
          error_description: 'Refresh token sk-ant-ort01-LEAKED-TOKEN-XXXXXXXXXXXXXXXXXX is dead',
        },
      })
    )

    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: inserted.subId,
      triggeredBy: 'manual',
    })

    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(1)
    // The error string must NOT contain the leaked token shape.
    expect(logs[0]?.error ?? '').not.toMatch(/sk-ant-ort01/)
    expect(logs[0]?.error ?? '').toContain('<redacted>')
  })
})
