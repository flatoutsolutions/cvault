/**
 * Spec: §5 / §9 — `subscriptions.actions.refreshSub`.
 *
 * Multi-machine refresh coordinator. The CLI sends an optional
 * `localState` (the local Keychain blob) so the server can adopt it
 * when it's newer than what the vault holds — a multi-laptop scenario
 * where Claude Code rotated tokens locally before cvault saw it.
 *
 * Behaviors covered (red-green-refactor):
 *  - rejects unauthenticated callers
 *  - throws NOT_FOUND when slot doesn't match the caller's subs
 *  - in-sync (vault == local) returns 'inSync' with current plaintext
 *  - vault newer than local returns 'pulledFresh' with vault's plaintext
 *  - local newer than vault: vault adopts local state, returns 'adoptedLocal'
 *  - near-expiry triggers Anthropic refresh, returns 'refreshedFromAnthropic'
 *  - --force triggers Anthropic even when not near expiry
 *  - Anthropic invalid_grant marks reloginRequired and throws RELOGIN_REQUIRED
 *  - successful call inserts a machineActivity row with action='refresh'
 *  - omitted localState path works (returns vault state without comparing)
 *  - returns metadata fields the CLI needs (expiresAt, lastRefreshedAt, contentHash)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { __setAnthropicFetch } from './anthropic'
import { decrypt, encrypt } from './crypto'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 17).toString('base64')
  // Default: stub Anthropic with a 429 so any unexpected refresh call
  // fails loud rather than hitting the real network. Tests that need a
  // specific outcome override this stub.
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

/**
 * Build a `claudeAiOauth`-shaped plaintext blob with the given expiresAt
 * and a deterministic refreshToken suffix so tests can assert which
 * version (vault or local) won the merge.
 */
function makePlaintextBlob(opts: { expiresAt: number; rtSuffix: string }): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat01-${opts.rtSuffix}-AT-AAAAAAAAAAAAAAAA`,
      refreshToken: `sk-ant-ort01-${opts.rtSuffix}-RT-BBBBBBBBBBBBBBBB`,
      expiresAt: opts.expiresAt,
      scopes: ['user:inference'],
    },
  })
}

async function seedSub(t: ReturnType<typeof vault>, opts: { expiresAt: number; rtSuffix: string }) {
  await seedUser(t)
  const plaintext = makePlaintextBlob(opts)
  const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
  return await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
    email: 'multi@example.com',
    ciphertext,
    nonce,
    keyVersion,
    expiresAt: opts.expiresAt,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
  })
}

describe('subscriptions.actions.refreshSub', () => {
  it('throws when caller is not authenticated', async () => {
    const t = vault()
    await expect(t.action(api.subscriptions.actions.refreshSub, { slot: 1 })).rejects.toThrow(/authenticated/i)
  })

  it('throws NOT_FOUND when slot does not match a sub the caller owns', async () => {
    const t = vault()
    await seedSub(t, { expiresAt: Date.now() + 60 * 60 * 1000, rtSuffix: 'V1' })
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, { slot: 99 })
    ).rejects.toThrow(/not.*found|no subscription/i)
  })

  it('returns inSync when vault and local agree and not near expiry', async () => {
    const t = vault()
    const expiresAt = Date.now() + 60 * 60 * 1000
    const inserted = await seedSub(t, { expiresAt, rtSuffix: 'SAME' })
    const localState = makePlaintextBlob({ expiresAt, rtSuffix: 'SAME' })

    const fetchStub = makeFetchStub({ status: 200, body: {} })
    __setAnthropicFetch(fetchStub)

    const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      localState,
    })

    expect(result.action).toBe('inSync')
    expect(fetchStub).not.toHaveBeenCalled()
    expect(result.email).toBe('multi@example.com')
    expect(result.slot).toBe(inserted.slot)
    expect(typeof result.contentHash).toBe('string')
    expect(result.contentHash.length).toBeGreaterThan(0)
  })

  it('returns pulledFresh and the vault state when vault is newer than local', async () => {
    const t = vault()
    const vaultExpires = Date.now() + 4 * 60 * 60 * 1000
    const inserted = await seedSub(t, { expiresAt: vaultExpires, rtSuffix: 'VAULT' })

    // Local state has an older expiresAt — the vault has the newer rotation.
    const localState = makePlaintextBlob({
      expiresAt: vaultExpires - 60 * 60 * 1000,
      rtSuffix: 'OLDLOCAL',
    })

    const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      localState,
    })

    expect(result.action).toBe('pulledFresh')
    // The returned plaintext must be the vault's, not the local.
    const parsed = JSON.parse(result.plaintextBlob) as { claudeAiOauth: { refreshToken: string } }
    expect(parsed.claudeAiOauth.refreshToken).toContain('VAULT')
    expect(parsed.claudeAiOauth.refreshToken).not.toContain('OLDLOCAL')
  })

  it('adopts local state when local is newer and persists it as the new vault state', async () => {
    const t = vault()
    const oldExpires = Date.now() + 30 * 60 * 1000
    const inserted = await seedSub(t, { expiresAt: oldExpires, rtSuffix: 'OLDVAULT' })

    // Local state is from a more-recent rotation — newer expiresAt and a
    // different refresh token shape. The server must adopt it.
    const newExpires = oldExpires + 4 * 60 * 60 * 1000
    const localState = makePlaintextBlob({
      expiresAt: newExpires,
      rtSuffix: 'NEWLOCAL',
    })

    const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      localState,
    })

    expect(result.action).toBe('adoptedLocal')
    // Returned plaintext is the newly-adopted local state.
    const parsed = JSON.parse(result.plaintextBlob) as { claudeAiOauth: { refreshToken: string; expiresAt: number } }
    expect(parsed.claudeAiOauth.refreshToken).toContain('NEWLOCAL')

    // Vault row was rewritten with the new ciphertext + the local's expiresAt.
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.expiresAt).toBe(newExpires)
    const recovered = decrypt(
      after?.ciphertext ?? new ArrayBuffer(0),
      after?.nonce ?? new ArrayBuffer(0),
      after?.keyVersion
    )
    const recoveredParsed = JSON.parse(recovered) as { claudeAiOauth: { refreshToken: string } }
    expect(recoveredParsed.claudeAiOauth.refreshToken).toContain('NEWLOCAL')
  })

  it('triggers an Anthropic refresh when vault is near expiry', async () => {
    const t = vault()
    // Within the 5-minute proactive window.
    const nearExpiry = Date.now() + 60 * 1000
    const inserted = await seedSub(t, { expiresAt: nearExpiry, rtSuffix: 'EXPIRING' })

    const newExpiresIn = 8 * 60 * 60 // 8h
    const fetchStub = makeFetchStub({
      status: 200,
      body: {
        access_token: 'sk-ant-oat01-REFRESHED-CCCCCCCCCCCCCCCC',
        refresh_token: 'sk-ant-ort01-REFRESHED-DDDDDDDDDDDDDDDD',
        expires_in: newExpiresIn,
        scope: 'user:inference',
      },
    })
    __setAnthropicFetch(fetchStub)

    const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
    })

    expect(result.action).toBe('refreshedFromAnthropic')
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)

    // refreshLog has a success row.
    const logs = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('success')
    expect(logs[0]?.triggeredBy).toBe('manual')
  })

  it('triggers an Anthropic refresh when force is true even if not near expiry', async () => {
    const t = vault()
    // Far from expiry — only `force: true` should drive the refresh.
    const farExpiry = Date.now() + 4 * 60 * 60 * 1000
    const inserted = await seedSub(t, { expiresAt: farExpiry, rtSuffix: 'FAR' })

    const fetchStub = makeFetchStub({
      status: 200,
      body: {
        access_token: 'sk-ant-oat01-FORCED-EEEEEEEEEEEEEEEE',
        refresh_token: 'sk-ant-ort01-FORCED-FFFFFFFFFFFFFFFF',
        expires_in: 8 * 60 * 60,
      },
    })
    __setAnthropicFetch(fetchStub)

    const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      force: true,
    })

    expect(result.action).toBe('refreshedFromAnthropic')
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('throws RELOGIN_REQUIRED when Anthropic returns invalid_grant', async () => {
    const t = vault()
    const nearExpiry = Date.now() + 60 * 1000
    const inserted = await seedSub(t, { expiresAt: nearExpiry, rtSuffix: 'DEAD' })

    __setAnthropicFetch(
      makeFetchStub({
        status: 401,
        body: { error: 'invalid_grant', error_description: 'refresh token revoked' },
      })
    )

    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
        slot: inserted.slot,
      })
    ).rejects.toThrow(/relogin.*required|relogin_required/i)

    // refreshExpiresAt was clamped on the row.
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.refreshExpiresAt).toBeLessThanOrEqual(Date.now())
  })

  it("inserts a machineActivity row with action='refresh' on success", async () => {
    const t = vault()
    const expiresAt = Date.now() + 4 * 60 * 60 * 1000
    const inserted = await seedSub(t, { expiresAt, rtSuffix: 'AUDIT' })
    const localState = makePlaintextBlob({ expiresAt, rtSuffix: 'AUDIT' })

    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      localState,
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const refreshRow = rows.find((r) => r.action === 'refresh')
    expect(refreshRow).toBeDefined()
    expect(refreshRow?.subscriptionId).toEqual(inserted.subId)
  })

  it('works without localState by returning the current vault state', async () => {
    const t = vault()
    const expiresAt = Date.now() + 4 * 60 * 60 * 1000
    const inserted = await seedSub(t, { expiresAt, rtSuffix: 'NOLOCAL' })

    const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
    })

    // Without a localState comparison the server has no way to detect drift.
    // Either inSync (no refresh needed) or refreshedFromAnthropic (near-expiry)
    // is acceptable; we expect inSync here because the sub is far from expiry.
    expect(result.action).toBe('inSync')
    const parsed = JSON.parse(result.plaintextBlob) as { claudeAiOauth: { refreshToken: string } }
    expect(parsed.claudeAiOauth.refreshToken).toContain('NOLOCAL')
  })

  it("does not adopt local when local's expiresAt is missing or malformed", async () => {
    const t = vault()
    const expiresAt = Date.now() + 4 * 60 * 60 * 1000
    const inserted = await seedSub(t, { expiresAt, rtSuffix: 'GOOD' })

    // Local state has no expiresAt — server cannot tell which is newer,
    // so it must NOT silently overwrite the vault.
    const malformed = JSON.stringify({ claudeAiOauth: { accessToken: 'X', refreshToken: 'Y' } })

    const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      localState: malformed,
    })

    // Either inSync (treated as equal/older) or pulledFresh — what we
    // require is that the vault state was NOT replaced by the malformed
    // local state.
    expect(result.action).not.toBe('adoptedLocal')
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    const recovered = decrypt(
      after?.ciphertext ?? new ArrayBuffer(0),
      after?.nonce ?? new ArrayBuffer(0),
      after?.keyVersion
    )
    expect(recovered).toContain('GOOD')
  })

  it('rejects refreshSub when the caller does not own the sub', async () => {
    const t = vault()
    const inserted = await seedSub(t, { expiresAt: Date.now() + 60 * 60 * 1000, rtSuffix: 'OWNER' })
    void inserted

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

    // Bob's slot 1 doesn't exist either, so the action must not return
    // Alice's row even though the slot number matches.
    await expect(t.withIdentity(bob).action(api.subscriptions.actions.refreshSub, { slot: 1 })).rejects.toThrow(
      /not.*found|no subscription/i
    )

    // Suppress unused import warnings; internal isn't referenced here.
    void internal
  })

  // M1 regression: lease-holder must re-check expiresAt after acquiring the
  // lease. Without that re-check, two callers can each independently decide
  // "needs refresh", the loser acquires the lease AFTER the winner already
  // committed a new (rotated) RT, then refreshes against Anthropic with the
  // now-invalidated RT → invalid_grant → spurious reloginRequired. The fix
  // is to re-fetch inside the lease-winner path and short-circuit if
  // expiresAt is fresh.
  it('M1: lease winner re-checks expiresAt and short-circuits after another caller already refreshed', async () => {
    const t = vault()
    // Seed near-expiry so both passes initially want to refresh.
    const nearExpiry = Date.now() + 60 * 1000
    const inserted = await seedSub(t, { expiresAt: nearExpiry, rtSuffix: 'PRE' })

    // First fetch stub returns a successful refresh — the "winner".
    let fetchCount = 0
    __setAnthropicFetch(
      vi.fn(() => {
        fetchCount += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'sk-ant-oat01-WINNER-AAAAAAAAAAAAAAAA',
              refresh_token: 'sk-ant-ort01-WINNER-BBBBBBBBBBBBBBBB',
              expires_in: 8 * 60 * 60,
              scope: 'user:inference',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      }) as typeof fetch
    )

    // First call wins the lease + refreshes.
    await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, { slot: inserted.slot })
    expect(fetchCount).toBe(1)

    // Snapshot the post-winner state. Anything sane wouldn't drive a second
    // Anthropic call now because the row's expiresAt is fresh.
    const afterWinner = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(afterWinner?.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)

    // Second call: the row IS already fresh now, so the lease-winner
    // re-check should short-circuit and NOT call Anthropic again. Without
    // M1, a stale read in a real concurrent scenario would let both calls
    // hit Anthropic and the loser would get invalid_grant.
    //
    // Simulate the "stale read" race by manually invoking the internal
    // refreshOAuthToken AFTER the refresh has happened — the lease check
    // we want to add must observe the row is fresh and bail.
    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: inserted.subId,
      triggeredBy: 'manual',
    })

    // CRITICAL: fetchCount stays at 1 — the second action observed the
    // fresh state via the post-lease re-check and did NOT hit Anthropic.
    expect(fetchCount).toBe(1)
  })

  // M5 regression: forced refresh that fails (decrypt error / Anthropic 5xx)
  // must surface a REFRESH_FAILED action label instead of misleading
  // "Already in sync". The CLI keys its exit code off this.
  it('M5/S5: surfaces REFRESH_FAILED when forced refresh did not advance lastRefreshedAt', async () => {
    const t = vault()
    const expiresAt = Date.now() + 4 * 60 * 60 * 1000
    const inserted = await seedSub(t, { expiresAt, rtSuffix: 'STUCK' })

    // Tamper the ciphertext so the inner refreshOAuthToken bails on decrypt
    // (releases lease, logs failure, returns null).
    await t.run(async (ctx) => {
      const sub = await ctx.db.get('subscriptions', inserted.subId)
      if (!sub) throw new Error('seed disappeared')
      const ct = new Uint8Array(sub.ciphertext)
      ct[0] = (ct[0] ?? 0) ^ 0xff
      await ctx.db.patch('subscriptions', inserted.subId, { ciphertext: ct.buffer })
    })

    // Forced refresh — caller wants Anthropic to be hit. With a corrupt
    // ciphertext, refreshOAuthToken cannot decrypt and bails silently.
    // refreshSub MUST surface that as an error rather than reporting
    // "inSync" against the corrupt row.
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
        slot: inserted.slot,
        force: true,
      })
    ).rejects.toThrow(/refresh.*fail/i)
  })

  // S6 regression: when force=true AND local is newer, the resulting action
  // label must be `refreshedFromAnthropic` — the rotation wins precedence.
  it('S6: force=true + local newer than vault → action label is refreshedFromAnthropic, not adoptedLocal', async () => {
    const t = vault()
    const oldExpires = Date.now() + 30 * 60 * 1000
    const inserted = await seedSub(t, { expiresAt: oldExpires, rtSuffix: 'OLDVAULT' })

    const newExpires = oldExpires + 4 * 60 * 60 * 1000
    const localState = makePlaintextBlob({ expiresAt: newExpires, rtSuffix: 'NEWLOCAL' })

    __setAnthropicFetch(
      makeFetchStub({
        status: 200,
        body: {
          access_token: 'sk-ant-oat01-FORCED-EEEEEEEEEEEEEEEE',
          refresh_token: 'sk-ant-ort01-FORCED-FFFFFFFFFFFFFFFF',
          expires_in: 8 * 60 * 60,
        },
      })
    )

    const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      localState,
      force: true,
    })

    // Precedence rule: a real Anthropic refresh wins over local-adoption.
    expect(result.action).toBe('refreshedFromAnthropic')
  })
})
