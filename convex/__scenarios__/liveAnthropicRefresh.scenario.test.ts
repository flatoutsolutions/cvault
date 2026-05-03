/**
 * Scenario #15 — Live Anthropic OAuth refresh roundtrip.
 *
 * Plan: docs/research/scenario-tests-plan.md §4.15
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §11
 *       (`__scenarios__/refreshCycle.scenario.ts — live cycle against dev
 *        deploy, gated on VAULT_TEST_REFRESH_TOKEN`)
 * Reference: docs/research/anthropic-oauth-refresh.md (endpoint + body shape)
 *
 * Story:
 *   Hits the *real* `https://platform.claude.com/v1/oauth/token` endpoint
 *   using a real refresh token the operator captured from a real Claude
 *   Code login. Confirms our wire contract still matches Anthropic's
 *   server, end-to-end.
 *
 * Important caveats:
 *   - This test consumes the supplied refresh token. Anthropic rotates
 *     refresh tokens on use (see anthropic-oauth-refresh.md §"Token
 *     Rotation Behavior"); the seed token will be dead after this runs.
 *     Capture a fresh one each time.
 *   - This test is `it.skip`'d by default because no real token is in env.
 *     To enable, set `VAULT_TEST_REFRESH_TOKEN` to the value of
 *     `claudeAiOauth.refreshToken` from a real `~/.claude/.credentials.json`,
 *     then run `yarn test:scenario`.
 *   - We never bake a real token into source. Reading from env only.
 *
 * Runtime: convex-node (real `fetch`, real `node:crypto`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'
import { seedSubscription, withVaultKey } from './_helpers.scenario'

const LIVE_REFRESH_TOKEN = process.env.VAULT_TEST_REFRESH_TOKEN

// Distinct from other scenario fill bytes (encryptionIntegrity uses 31).
const KEY_FILL_BYTE = 41

let keyHandle: ReturnType<typeof withVaultKey>

beforeEach(() => {
  keyHandle = withVaultKey(KEY_FILL_BYTE)
})

afterEach(() => {
  keyHandle.restore()
})

describe('scenario: live Anthropic OAuth refresh', () => {
  // Use describe.skipIf at the file level via a guarded `it` so the suite
  // structure stays visible in the runner output even when env is missing.
  // Why a guarded `it` rather than `it.skipIf`: vitest's `it.skipIf` runs
  // the title-builder eagerly; a guarded `it` keeps the test name visible
  // without ever instantiating any state when the env is missing.
  if (!LIVE_REFRESH_TOKEN) {
    it.skip('live refresh roundtrip — set VAULT_TEST_REFRESH_TOKEN=<refresh_token from ~/.claude/.credentials.json> to enable', () => {
      // Intentionally empty — body never runs. The test name itself
      // documents how to enable.
    })
    return
  }

  // From here on we have a real refresh token to burn.
  it('refreshes an expired access token against the real Anthropic endpoint', async () => {
    const t = vault()

    // Seed a sub whose stored blob carries the LIVE refresh token we are
    // about to burn. expiresAt is set in the past so the action would
    // refresh proactively if called via pullForSwitch — but here we drive
    // refreshOAuthToken directly to keep the test focused on the wire.
    const initialAccessToken = 'sk-ant-oat01-EXPIRED-PLACEHOLDER-BEFORE-REFRESH'
    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: initialAccessToken,
        refreshToken: LIVE_REFRESH_TOKEN,
        expiresAt: Date.now() - 60_000,
        scopes: ['user:inference'],
      },
    })
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'live-refresh@example.com',
      expiresAt: Date.now() - 60_000,
      blob,
    })

    const before = await t.run(async (ctx) => {
      return await ctx.db.get('subscriptions', seeded.subId)
    })
    expect(before).not.toBeNull()
    const beforeExpiresAt = before?.expiresAt ?? 0
    const beforeCiphertextHex = Buffer.from(before?.ciphertext ?? new ArrayBuffer(0)).toString('hex')

    // Drive the real refresh. NO __setAnthropicFetch — we want the actual
    // network call. This is the whole point of the scenario.
    await t.action(internal.subscriptions.actions.refreshOAuthToken, {
      subId: seeded.subId,
      triggeredBy: 'manual',
    })

    // Fetch the updated row and decrypt to compare against the seed blob.
    const after = await t.run(async (ctx) => {
      return await ctx.db.get('subscriptions', seeded.subId)
    })
    expect(after).not.toBeNull()

    // expiresAt advanced into the future. Anthropic typically returns 8h.
    const afterExpiresAt = after?.expiresAt ?? 0
    expect(afterExpiresAt).toBeGreaterThan(beforeExpiresAt)
    expect(afterExpiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)

    // Ciphertext rotated (fresh nonce + new plaintext means new bytes).
    const afterCiphertextHex = Buffer.from(after?.ciphertext ?? new ArrayBuffer(0)).toString('hex')
    expect(afterCiphertextHex).not.toBe(beforeCiphertextHex)

    // Decrypt the new ciphertext and confirm the access token differs from
    // the placeholder. We dynamically import crypto because it's a `'use
    // node'` module and we want the test runner to load it lazily under
    // Node, matching how the action loads it.
    const { decrypt } = await import('../subscriptions/crypto')
    const newPlaintext = decrypt(
      after?.ciphertext ?? new ArrayBuffer(0),
      after?.nonce ?? new ArrayBuffer(0),
      after?.keyVersion
    )
    type OAuthBlob = {
      claudeAiOauth?: {
        accessToken?: string
        refreshToken?: string
        expiresAt?: number
      }
    }
    const parsed = JSON.parse(newPlaintext) as OAuthBlob
    expect(parsed.claudeAiOauth?.accessToken).toBeDefined()
    expect(parsed.claudeAiOauth?.accessToken).not.toBe(initialAccessToken)
    // New access token is sk-ant-oat01- shaped per Anthropic's contract.
    expect(parsed.claudeAiOauth?.accessToken ?? '').toMatch(/^sk-ant-/)

    // Refresh log records exactly one success row.
    const logs = await t.run(async (ctx) => {
      return await ctx.db.query('refreshLog').collect()
    })
    expect(logs).toHaveLength(1)
    expect(logs[0]?.outcome).toBe('success')
    expect(logs[0]?.subscriptionId).toEqual(seeded.subId)
    expect(logs[0]?.triggeredBy).toBe('manual')
  })

  // Note: only one test in this suite runs the live wire because Anthropic
  // rotates refresh tokens on use — the env-supplied token is consumed by
  // the test above. A second live call would fail with 401 invalid_grant,
  // which is already covered by refresh.test.ts's "marks reloginRequired
  // when Anthropic returns 401" (mocked).
})
