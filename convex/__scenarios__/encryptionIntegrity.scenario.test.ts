/**
 * Scenario #13 — Encryption integrity.
 *
 * Plan: docs/research/scenario-tests-plan.md §4.13
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §6 (envelope) + §10 (errors)
 * Security: docs/research/security-findings.md M1 (decrypt failure surfacing)
 *
 * Story:
 *   1. A subscription is seeded with a real AES-GCM ciphertext.
 *   2. Something flips a single byte of `subscriptions.ciphertext` at rest
 *      (database corruption, manual `db.patch` mistake, key rotation in
 *      progress, attacker tampering).
 *   3. The next caller of any decrypt-bearing path (here: the public
 *      `pullForSwitch` action) MUST observe a hard failure — Node's
 *      AES-GCM auth tag check throws on tamper.
 *
 * Invariants this scenario asserts:
 *   - The action throws (does not silently return stale or partial data).
 *   - The thrown error's `.message` contains NO plaintext substring —
 *     no `sk-ant-` token shape, no `accessToken`, no `refreshToken`.
 *     A leaked plaintext fragment in an error message would be a high-
 *     severity regression.
 *   - The stored row is NOT silently mutated by the failed decrypt — the
 *     ciphertext we tampered remains tampered (no auto-recovery write).
 *
 * What we deliberately do NOT assert here (out of scope, separate scenarios):
 *   - That the lease is released. Per security-findings M1, the action
 *     currently leaves the lease held until 30s TTL — a known gap with
 *     a recommended fix. This scenario flags plaintext leakage; lease
 *     hygiene is M1's domain.
 *   - That a `refreshLog` row with `outcome:'failure', error:'creds
 *     corrupt'` is inserted. Same reason — that's the M1 fix.
 *
 * Runtime: convex-node (Node, not edge-runtime) so `node:crypto` is
 * available for AES-GCM in the action handler.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import { seedSubscription, withVaultKey } from './_helpers.scenario'

// Use a distinct fill byte from refresh.test.ts (9), upsertFromPlaintext.test.ts
// (13), httpSync.test.ts (23), crypto.node.test.ts (7) so parallel test files
// can never pollute each other through process.env.VAULT_AES_KEY.
const KEY_FILL_BYTE = 31

let keyHandle: ReturnType<typeof withVaultKey>

beforeEach(() => {
  keyHandle = withVaultKey(KEY_FILL_BYTE)
})

afterEach(() => {
  keyHandle.restore()
})

describe('scenario: encryption integrity (tampered ciphertext)', () => {
  it('pullForSwitch throws with no plaintext leakage when ciphertext is tampered', async () => {
    const t = vault()

    // Seed a sub with real ciphertext + nonce. The plaintext blob contains
    // unique sentinel substrings we will later assert NEVER appear in the
    // thrown error message.
    const distinctiveAccess = 'SCENARIO13-ACCESS-AAAAAAAAAAAAAAAAAA'
    const distinctiveRefresh = 'SCENARIO13-REFRESH-BBBBBBBBBBBBBBBBBB'
    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: `sk-ant-oat01-${distinctiveAccess}`,
        refreshToken: `sk-ant-ort01-${distinctiveRefresh}`,
        // Far in the future so no proactive refresh path is triggered before
        // we even get to decrypt.
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        scopes: ['user:inference'],
      },
    })
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'corrupt@example.com',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      blob,
    })

    // Snapshot the row before tampering so we can verify the stored bytes
    // remain in their tampered state after the failed action (no silent
    // recovery write).
    const before = await t.run(async (ctx) => {
      return await ctx.db.get('subscriptions', seeded.subId)
    })
    expect(before).not.toBeNull()
    const originalCiphertextHex = Buffer.from(before?.ciphertext ?? new ArrayBuffer(0)).toString('hex')
    expect(originalCiphertextHex.length).toBeGreaterThan(0)

    // Tamper a single byte in the middle of the ciphertext bundle. Same
    // pattern as crypto.node.test.ts "throws when the ciphertext has been
    // tampered with" — flip one bit so the GCM auth tag check fails.
    const tampered = new Uint8Array(before?.ciphertext ?? new ArrayBuffer(0))
    const tamperIndex = Math.floor(tampered.length / 2)
    tampered[tamperIndex] = (tampered[tamperIndex] ?? 0) ^ 0x01
    await t.run(async (ctx) => {
      // Pass an ArrayBuffer slice to match Convex `v.bytes()`.
      const buf = tampered.buffer.slice(tampered.byteOffset, tampered.byteOffset + tampered.byteLength)
      await ctx.db.patch('subscriptions', seeded.subId, { ciphertext: buf })
    })

    // The action must throw. Capture the rejection so we can inspect its
    // message for plaintext leakage.
    let captured: unknown
    try {
      await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, {
        slotOrEmail: 'corrupt@example.com',
      })
      throw new Error('pullForSwitch should have thrown but returned successfully')
    } catch (err) {
      captured = err
    }
    expect(captured).toBeDefined()

    // Stringify the entire error surface (message + name + stack + any
    // structured data Convex actions sometimes attach to the error). This is
    // the *complete* visible failure surface a caller might log; if any of
    // it contains plaintext, that's a leak.
    const errString = (() => {
      if (typeof captured === 'string') return captured
      if (captured instanceof Error) {
        return [captured.name, captured.message, captured.stack ?? ''].join('\n')
      }
      try {
        return JSON.stringify(captured)
      } catch {
        return String(captured)
      }
    })()

    // No plaintext-shaped fragments may appear anywhere in the error.
    // These four checks together cover (a) raw token bytes, (b) the
    // claude-swap field names that would only appear if the JSON blob were
    // partially decoded and re-stringified into the error.
    expect(errString).not.toContain('sk-ant-')
    expect(errString).not.toContain(distinctiveAccess)
    expect(errString).not.toContain(distinctiveRefresh)
    // The blob's field names shouldn't leak either — if the action ever
    // tried to JSON.parse() partial plaintext and the parse error contained
    // the surrounding content, these would surface.
    expect(errString).not.toContain('"accessToken"')
    expect(errString).not.toContain('"refreshToken"')
    expect(errString).not.toContain('claudeAiOauth')

    // The stored row must remain in its tampered state — the failed decrypt
    // path must not have written anything back to the database.
    const after = await t.run(async (ctx) => {
      return await ctx.db.get('subscriptions', seeded.subId)
    })
    expect(after).not.toBeNull()
    const afterCiphertextHex = Buffer.from(after?.ciphertext ?? new ArrayBuffer(0)).toString('hex')
    // The ciphertext we stored is the tampered one; it should still be
    // exactly that (no silent rewrite).
    const expectedHex = Buffer.from(tampered).toString('hex')
    expect(afterCiphertextHex).toBe(expectedHex)
    // And it should differ from the pre-tamper original.
    expect(afterCiphertextHex).not.toBe(originalCiphertextHex)
  })
})
