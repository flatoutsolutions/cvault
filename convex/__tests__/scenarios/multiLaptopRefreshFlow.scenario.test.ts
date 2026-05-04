/**
 * Scenario — multi-laptop OAuth refresh flow.
 *
 * Background:
 *   The user runs Claude Code (and `cvault`) on multiple laptops. Anthropic
 *   rotates the refresh_token on EVERY refresh call (verified empirically
 *   via scripts/probe-oauth-refresh.ts). Without coordination, whichever
 *   laptop refreshes last invalidates every other laptop's token —
 *   causing RELOGIN_REQUIRED on the others.
 *
 *   `subscriptions.actions.refreshSub` is the multi-laptop coordinator.
 *   The CLI sends an optional `localState` (the local Keychain blob); the
 *   server uses the embedded `claudeAiOauth.expiresAt` as a monotonic
 *   logical clock to pick whichever copy is freshest. The vault adopts
 *   the freshest state so subsequent pulls converge there.
 *
 * What this scenario asserts (the END-TO-END flow across two laptops):
 *
 *   Phase 1 — Vault state V0 is seeded.
 *   Phase 2 — Machine A's local Claude Code rotated the token locally
 *             before cvault saw it. A runs `cvault refresh` with the
 *             newer local state V1. The vault adopts V1.
 *   Phase 3 — Machine B comes online holding the OLD vault state V0
 *             (it never saw V1). B runs `cvault refresh` with V0.
 *             The vault MUST NOT regress to V0.
 *   Phase 4 — Machine B's call returns the freshest state (V1) so its
 *             local Keychain can converge.
 *   Phase 5 — Throughout, no spurious RELOGIN_REQUIRED is set on the
 *             vault row (`refreshExpiresAt` stays unset).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../../_generated/api'
import { __setAnthropicFetch } from '../../subscriptions/anthropic'
import { decrypt, encrypt } from '../../subscriptions/crypto'
import { TEST_IDENTITY, seedUser, vault } from '../helpers'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 31).toString('base64')
  // Default to a 429 stub so any unexpected Anthropic call fails loud
  // rather than hitting the real network. None of these scenarios
  // SHOULD make HTTP calls — local-adoption + vault-newer-than-local
  // are pure server-side comparisons.
  __setAnthropicFetch((() => Promise.resolve(new Response('rate-limited', { status: 429 }))) as typeof fetch)
  // Fake timers so any scheduled functions (e.g. fetchUsageForSub from
  // upsertFromPlaintext) drain inside the test transaction window.
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

/**
 * Build a `claudeAiOauth`-shaped plaintext blob with the given expiresAt
 * and a deterministic suffix so tests can assert which version (V0/V1/V2)
 * the vault holds at each phase.
 */
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

async function seedSubV0(t: ReturnType<typeof vault>, expiresAt: number) {
  await seedUser(t)
  const plaintext = makePlaintextBlob({ expiresAt, versionSuffix: 'V0' })
  const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
  return await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
    email: 'multi@example.com',
    ciphertext,
    nonce,
    keyVersion,
    expiresAt,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
  })
}

describe('Scenario — multi-laptop refresh flow converges on freshest state', () => {
  it('Machine A adopts local V1 → Machine B with stale V0 does NOT regress vault → vault stays V1', async () => {
    const t = vault()

    // ---------- Phase 1 — Vault state V0 ----------
    // V0 is far enough from expiry that no Anthropic refresh fires.
    const v0Expires = Date.now() + 4 * 60 * 60 * 1000
    const inserted = await seedSubV0(t, v0Expires)
    const subId = inserted.subId

    // Sanity: the seeded row holds V0 plaintext.
    const phase1Row = await t.run(async (ctx) => await ctx.db.get('subscriptions', subId))
    expect(phase1Row?.expiresAt).toBe(v0Expires)
    expect(
      decrypt(
        phase1Row?.ciphertext ?? new ArrayBuffer(0),
        phase1Row?.nonce ?? new ArrayBuffer(0),
        phase1Row?.keyVersion
      )
    ).toContain('V0')

    // ---------- Phase 2 — Machine A pushes V1 to vault ----------
    // Machine A's local Claude Code rotated tokens locally. Its Keychain
    // now holds V1 with a strictly newer expiresAt.
    const v1Expires = v0Expires + 4 * 60 * 60 * 1000
    const machineAlocal = makePlaintextBlob({ expiresAt: v1Expires, versionSuffix: 'V1' })

    const aResult = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      localState: machineAlocal,
    })

    expect(aResult.action).toBe('adoptedLocal')
    // Vault now holds V1.
    const phase2Row = await t.run(async (ctx) => await ctx.db.get('subscriptions', subId))
    expect(phase2Row?.expiresAt).toBe(v1Expires)
    const phase2Plaintext = decrypt(
      phase2Row?.ciphertext ?? new ArrayBuffer(0),
      phase2Row?.nonce ?? new ArrayBuffer(0),
      phase2Row?.keyVersion
    )
    expect(phase2Plaintext).toContain('V1')
    expect(phase2Plaintext).not.toContain('V0')

    // ---------- Phase 3 — Machine B refreshes with stale V0 ----------
    // Machine B never saw V1 — it still holds V0 in its local Keychain.
    // It runs `cvault refresh` with V0. The server MUST NOT adopt the
    // older state (regression). The CAS in `adoptLocalState` enforces
    // this: `localExpiresAt <= sub.expiresAt` returns `adopted: false`.
    const machineBlocal = makePlaintextBlob({ expiresAt: v0Expires, versionSuffix: 'V0' })

    const bResult = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      localState: machineBlocal,
    })

    // The server's response tells B what to do: pull V1 down. The action
    // label is `pulledFresh` — vault is newer than local, so the CLI
    // should write the returned plaintext to its Keychain.
    expect(bResult.action).toBe('pulledFresh')

    // ---------- Phase 4 — vault state did NOT regress ----------
    // The most important invariant: V0 from machine B did NOT overwrite
    // the V1 that machine A had pushed. The vault row's expiresAt is
    // still V1's value.
    const phase4Row = await t.run(async (ctx) => await ctx.db.get('subscriptions', subId))
    expect(phase4Row?.expiresAt).toBe(v1Expires)
    const phase4Plaintext = decrypt(
      phase4Row?.ciphertext ?? new ArrayBuffer(0),
      phase4Row?.nonce ?? new ArrayBuffer(0),
      phase4Row?.keyVersion
    )
    expect(phase4Plaintext).toContain('V1')

    // The plaintext returned to machine B is the vault's V1 — what B
    // should write to its Keychain to converge.
    expect(bResult.plaintextBlob).toContain('V1')
    expect(bResult.plaintextBlob).not.toContain('V0')

    // ---------- Phase 5 — no spurious reloginRequired ----------
    // The whole flow uses purely server-local comparisons; no Anthropic
    // call was made, so no `invalid_grant` could possibly land. The
    // vault row's `refreshExpiresAt` should remain unset.
    expect(phase4Row?.refreshExpiresAt).toBeUndefined()

    // Defense-in-depth: refreshLog has zero rows because no Anthropic
    // refresh was driven. (The audit log on `machineActivity` DOES have
    // rows because every refreshSub call leaves an `action: 'refresh'`
    // row, which is the correct behavior — we just want to confirm no
    // refresh-token-level events landed.)
    const refreshRows = await t.run(async (ctx) => await ctx.db.query('refreshLog').collect())
    expect(refreshRows).toHaveLength(0)
  })

  it("ping-pong: A pushes V1, then B pushes V2 (newer than V1) — vault converges to V2; subsequent stale refresh from A doesn't regress", async () => {
    // Models the realistic case where both laptops rotate at different
    // times, each pushing their newer state. The vault must always
    // converge to the freshest, regardless of which order the calls
    // arrive in.
    const t = vault()

    const v0Expires = Date.now() + 2 * 60 * 60 * 1000
    const inserted = await seedSubV0(t, v0Expires)
    const subId = inserted.subId

    // Machine A pushes V1.
    const v1Expires = v0Expires + 60 * 60 * 1000
    const aResult1 = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      localState: makePlaintextBlob({ expiresAt: v1Expires, versionSuffix: 'V1' }),
    })
    expect(aResult1.action).toBe('adoptedLocal')

    // Machine B pushes V2 (newer than V1).
    const v2Expires = v1Expires + 60 * 60 * 1000
    const bResult = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      localState: makePlaintextBlob({ expiresAt: v2Expires, versionSuffix: 'V2' }),
    })
    expect(bResult.action).toBe('adoptedLocal')

    // Vault is at V2.
    const afterB = await t.run(async (ctx) => await ctx.db.get('subscriptions', subId))
    expect(afterB?.expiresAt).toBe(v2Expires)
    expect(
      decrypt(afterB?.ciphertext ?? new ArrayBuffer(0), afterB?.nonce ?? new ArrayBuffer(0), afterB?.keyVersion)
    ).toContain('V2')

    // Machine A returns later still holding V1 (never saw V2). It must
    // NOT regress the vault.
    const aResult2 = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      localState: makePlaintextBlob({ expiresAt: v1Expires, versionSuffix: 'V1' }),
    })
    expect(aResult2.action).toBe('pulledFresh')

    // Vault still V2.
    const final = await t.run(async (ctx) => await ctx.db.get('subscriptions', subId))
    expect(final?.expiresAt).toBe(v2Expires)
    expect(
      decrypt(final?.ciphertext ?? new ArrayBuffer(0), final?.nonce ?? new ArrayBuffer(0), final?.keyVersion)
    ).toContain('V2')

    // The plaintext returned to A is V2 — A's CLI converges its Keychain there.
    expect(aResult2.plaintextBlob).toContain('V2')
  })

  it('inSync when both laptops already agree on the vault state — no mutation, no spurious activity', async () => {
    // The "happy path" between syncs: both laptops have the same
    // (already-vault-synced) tokens. Refresh should be a clean no-op.
    const t = vault()
    const expires = Date.now() + 3 * 60 * 60 * 1000
    const inserted = await seedSubV0(t, expires)

    // Local matches vault byte-for-byte (same V0 plaintext, same expiresAt).
    const localState = makePlaintextBlob({ expiresAt: expires, versionSuffix: 'V0' })

    const before = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.refreshSub, {
      slot: inserted.slot,
      localState,
    })

    expect(result.action).toBe('inSync')

    // Row is byte-identical (same expiresAt, same lastRefreshedAt because
    // no mutation touched it).
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.expiresAt).toBe(before?.expiresAt)
    expect(after?.lastRefreshedAt).toBe(before?.lastRefreshedAt)
    expect(after?.refreshExpiresAt).toBeUndefined()
  })
})
