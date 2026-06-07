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
  const { ciphertext, nonce, keyVersion } = encrypt(plaintext)

  return await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
    email: 'rotate@example.com',
    ciphertext,
    nonce,
    keyVersion,
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
      triggeredBy: 'manual',
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
      triggeredBy: 'manual',
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
      triggeredBy: 'manual',
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

  /**
   * Shared-vault contract (`convex/utils/users.ts:3-7`): every authenticated
   * allowed-domain identity reads/writes any row. So when bob (allowed domain)
   * calls `requestRefresh` for a sub seeded by alice, the action MUST succeed
   * — the previous "ownership" guard was a leftover from the per-user model
   * and broke `cvault sync --all` cross-machine.
   *
   * The audit row records the ACTING identity (bob), not the sub's nominal
   * owner — that's the trail the dashboard's "Machines" view needs.
   *
   * machineActivity.userId semantics: pinned to the ACTING user's `users._id`,
   * not the sub's owner. Pre-fix the row recorded `sub.userId` (alice) which
   * produced a false trail ("alice did this" when bob actually did). The
   * audit page key for "who acted" is `clerkSessionId` (rendered in
   * `frontend/src/routes/dashboard/audit.lazy.tsx` via
   * `clerkSessionId.slice(0, 12)`); `userId` is metadata, not display, but
   * its semantics MUST be consistent with the rest of the audit signal.
   * "Actor" is the only sane choice: future filters like "rows acted on
   * by user X" can build on it; "rows affecting which sub" is already
   * covered by `subscriptionId`.
   */
  it('requestRefresh succeeds across users (shared vault) and audits the acting identity', async () => {
    const t = vault()
    const inserted = await seedSubscription(t)
    // Bob (a different allowed-domain identity) refreshes alice's sub.
    const bob = {
      subject: 'user_test_bob',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_bob',
      name: 'Bob',
      email: 'bob@flatout.solutions',
    }
    const bobId = await t.run(async (ctx) => {
      return await ctx.db.insert('users', {
        externalId: bob.subject,
        name: bob.name,
        primaryEmail: bob.email,
        otherEmails: [],
      })
    })
    __setAnthropicFetch(
      makeFetchStub({
        status: 200,
        body: {
          access_token: 'sk-ant-oat01-CROSS-AAAAAAAAAAAAAAAAAAAA',
          refresh_token: 'sk-ant-ort01-CROSS-BBBBBBBBBBBBBBBBBBBB',
          expires_in: 28_800,
        },
      })
    )

    await t.withIdentity(bob).action(api.subscriptions.actions.requestRefresh, {
      subId: inserted.subId,
    })

    // Audit row records bob as actor (clerkSessionId resolved from his
    // identity) and alice's subscriptionId as target. The userId column
    // is bob's _id (the actor), not alice's (the sub owner) — pre-fix
    // bug attributed cross-user pulls to the row's nominal owner.
    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const refreshRow = rows.find((r) => r.action === 'refresh')
    expect(refreshRow).toBeDefined()
    expect(refreshRow?.subscriptionId).toEqual(inserted.subId)
    expect(refreshRow?.userId).toEqual(bobId)
  })

  /**
   * pullForSwitch's machineActivity row attributes the ACTING user, not
   * the sub owner. Same audit-truth rule as `requestRefresh` above.
   * Pre-fix `pullForSwitch` wrote `userId: fresh.userId` which made every
   * `cvault sync --all` invocation against another user's sub look like
   * the sub owner did it.
   */
  it('pullForSwitch audits the acting user, not the sub owner', async () => {
    const t = vault()
    // Seed alice's sub fresh enough that the proactive-refresh path is a no-op.
    await seedUser(t)
    const { encrypt } = await import('./crypto')
    const futureExpiry = Date.now() + 60 * 60 * 1000
    const plaintext = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-ACTOR-AAAAAAAAAAAAAAAAAAAA',
        refreshToken: 'sk-ant-ort01-ACTOR-BBBBBBBBBBBBBBBBBBBB',
        expiresAt: futureExpiry,
        scopes: ['user:inference'],
      },
    })
    const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'actor-pull@example.com',
      ciphertext,
      nonce,
      keyVersion,
      expiresAt: futureExpiry,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    const bob = {
      subject: 'user_test_bob',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_bob',
      name: 'Bob',
      email: 'bob@flatout.solutions',
    }
    const bobId = await t.run(async (ctx) => {
      return await ctx.db.insert('users', {
        externalId: bob.subject,
        name: bob.name,
        primaryEmail: bob.email,
        otherEmails: [],
      })
    })

    await t.withIdentity(bob).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'actor-pull@example.com',
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const pullRow = rows.find((r) => r.action === 'pull' && r.subscriptionId === inserted.subId)
    expect(pullRow).toBeDefined()
    expect(pullRow?.userId).toEqual(bobId)
    expect(pullRow?.userId).not.toEqual(inserted.userId)
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
    const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'stale@example.com',
      ciphertext,
      nonce,
      keyVersion,
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
      triggeredBy: 'manual',
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
      triggeredBy: 'manual',
    })

    // Try to acquire the lease right away — it must succeed (no 30s TTL wait).
    const acq = await t.mutation(internal.subscriptions.mutations.tryAcquireRefreshLease, {
      subId: inserted.subId,
      holderToken: 'next-attempt',
    })
    expect(acq.acquired).toBe(true)
  })

  /**
   * RT-dead spam guard: a sub whose `refreshExpiresAt <= now` was already
   * marked dead (a prior refresh got `invalid_grant` from Anthropic).
   * The action MUST NOT re-drive Anthropic in that state — repeated
   * calls would otherwise burn an API call and log a fresh
   * `reloginRequired` row each time. With the `refreshExpiringTokens`
   * cron removed (audit fix #5), the only remaining callers are direct
   * (`cvault refresh`) or pull-on-use (`pullForSwitch`); this in-action
   * re-check ensures both short-circuit cleanly.
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
      triggeredBy: 'manual',
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
    const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'label-pull@example.com',
      ciphertext,
      nonce,
      keyVersion,
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

  /**
   * Caller-session attribution: the CLI's BAPI-minted JWT lacks a `sid`
   * claim (Clerk reservation; see `convex/utils/identity.ts`). Without
   * the explicit `clerkSessionId` arg every CLI-origin pull would write
   * the `unknown-session` sentinel and the dashboard's Machines view
   * would lose per-machine attribution. Locking this here so a future
   * refactor can't silently break the contract.
   */
  it('pullForSwitch writes the explicit machineId arg into the machineActivity row', async () => {
    const t = vault()
    await seedUser(t)
    const { encrypt } = await import('./crypto')
    // Fresh token so the proactive refresh path is a no-op.
    const futureExpiry = Date.now() + 60 * 60 * 1000
    const plaintext = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-SID-AAAAAAAAAAAAAAAAAAAA',
        refreshToken: 'sk-ant-ort01-SID-BBBBBBBBBBBBBBBBBBBB',
        expiresAt: futureExpiry,
        scopes: ['user:inference'],
      },
    })
    const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'sid-pull@example.com',
      ciphertext,
      nonce,
      keyVersion,
      expiresAt: futureExpiry,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // TEST_IDENTITY has no `sid` claim (mirrors a CLI-origin BAPI JWT),
    // so the fallback machineId is used.
    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'sid-pull@example.com',
      machineId: 'mach-x',
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const pullRow = rows.find((r) => r.action === 'pull')
    expect(pullRow?.machineId).toBe('mach-x')
  })

  /**
   * Production regression (the trigger for this hotfix): `cvault sync --all`
   * iterates every dashboard-visible sub and calls `pullForSwitch` for
   * each. The acting machine's owner is the Clerk identity at the time of
   * the call — NOT the nominal owner of the sub being pulled. The pre-fix
   * `getSubscriptionForActor` query scoped reads to the caller's user,
   * which produced NOT_FOUND for any sub owned by another co-tenant in
   * the shared vault. This test pins the post-fix behavior:
   *   1. Alice's sub is seeded, bob is authenticated.
   *   2. bob calls `pullForSwitch(alice's-email)` → succeeds, returns
   *      alice's plaintext.
   *   3. The machineActivity audit row records alice's subscriptionId as
   *      the target — preserving accountability.
   *
   * The seed uses a far-future expiresAt so the proactive-refresh path
   * is a no-op; this test asserts the lookup contract, not the refresh
   * cycle (which is covered by the surrounding tests in this describe).
   */
  it('pullForSwitch resolves any sub by email regardless of caller (shared vault)', async () => {
    const t = vault()
    // Alice owns a fresh-token sub. We can't reuse `seedSubscription()`
    // because its 1-minute expiry triggers proactive refresh and would
    // muddy the cross-user assertion with an Anthropic round-trip.
    await seedUser(t)
    const { encrypt } = await import('./crypto')
    const futureExpiry = Date.now() + 60 * 60 * 1000
    const plaintext = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-CROSS-AAAAAAAAAAAAAAAAAAAA',
        refreshToken: 'sk-ant-ort01-CROSS-BBBBBBBBBBBBBBBBBBBB',
        expiresAt: futureExpiry,
        scopes: ['user:inference'],
      },
    })
    const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'cross-user-pull@example.com',
      ciphertext,
      nonce,
      keyVersion,
      expiresAt: futureExpiry,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // Bob (a different allowed-domain identity) pulls alice's sub.
    const bob = {
      subject: 'user_test_bob',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_bob',
      name: 'Bob',
      email: 'bob@flatout.solutions',
    }
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: bob.subject,
        name: bob.name,
        primaryEmail: bob.email,
        otherEmails: [],
      })
    })

    const fetchStub = makeFetchStub({ status: 200, body: { access_token: 'X' } })
    __setAnthropicFetch(fetchStub)

    const result = await t.withIdentity(bob).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'cross-user-pull@example.com',
    })

    // Proactive refresh window is 5 minutes; futureExpiry is 1 hour — so
    // Anthropic must NOT be touched. If this stub fires, the test caught
    // a regression where the seed's expiry slipped into the window.
    expect(fetchStub).not.toHaveBeenCalled()
    expect(result.email).toBe('cross-user-pull@example.com')
    expect(result.plaintextBlob.length).toBeGreaterThan(0)

    // Audit: machineActivity row records alice's sub as target. The
    // `userId` column on the audit row is the sub's owner (alice) since
    // the action passes `fresh.userId`. The acting identity is captured
    // via clerkSessionId, which `resolveCallerSession` resolves from
    // bob's identity claim (or `unknown-session` fallback for BAPI JWTs).
    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const pullRow = rows.find((r) => r.action === 'pull')
    expect(pullRow).toBeDefined()
    expect(pullRow?.subscriptionId).toEqual(inserted.subId)
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
