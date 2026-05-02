/**
 * Scenario #2 — Add account flow (`cvault add`).
 *
 * Plan: docs/research/scenario-tests-plan.md §4.2.
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5
 *  + §6 (encryption envelope) + §7 (`cvault add`).
 *
 * What this scenario covers end-to-end:
 *  - `runAdd` invokes `claude-swap --add-account`, then `--status` to
 *    learn the new active slot, then `--export -` to capture credentials
 *  - The captured plaintext blob is dispatched to the typed
 *    `api.subscriptions.actions.upsertFromPlaintext` action
 *  - The dispatched payload contains:
 *      * the parsed email
 *      * the JSON-stringified `claudeAiOauth` blob (no extra wrappers)
 *      * `expiresAt`, `subscriptionType`, `rateLimitTier`, optional `label`
 *  - A follow-up `runList` reads the newly-stored sub back via
 *    `listForUser` (round-trip wire shape — strips ciphertext / nonce)
 *  - The fake backend's stored row never contains the AES master key and
 *    its `plaintextBlob` deserializes to the same OAuth tokens we sent
 *
 * What's stubbed:
 *  - `claude-swap` subprocess — we never spawn the real binary
 *  - `makeVaultClient` — wired to the in-memory `FakeVaultClient` whose
 *    handlers mirror the real Convex behavior closely enough that the
 *    follow-up `cvault list` call returns the row we just inserted
 */
import { api } from '@cvault/convex/api'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addAccountInteractive, exportAccount, status } from '../../src/claudeSwap'
import { runAdd } from '../../src/commands/add'
import { runList } from '../../src/commands/list'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { singleAccountEnvelope } from '../fixtures/envelopes/singleAccount'
import { cleanupTempHome, createFakeVaultClient, getCall, refName, setupTempHome } from './_helpers'

vi.mock('../../src/claudeSwap', () => ({
  addAccountInteractive: vi.fn().mockResolvedValue(undefined),
  status: vi.fn(),
  exportAccount: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

let tempHome: string

beforeEach(() => {
  tempHome = setupTempHome('cvault-add-test-')
})

afterEach(() => {
  cleanupTempHome(tempHome)
})

describe('Scenario #2 — Add account flow', () => {
  it('adds via claude-swap, dispatches typed upsertFromPlaintext, and the row reads back via listForUser', async () => {
    // Pretend `claude-swap --add-account` completed and we're now at slot 1.
    vi.mocked(status).mockReturnValueOnce('Active account: 1 (work@example.com)\n')
    const env = singleAccountEnvelope({ number: 1, email: 'work@example.com' })
    // Make sure the fixture's expiresAt is realistic.
    env.accounts[0]!.credentials.claudeAiOauth.expiresAt = 1_900_000_000_000
    vi.mocked(exportAccount).mockReturnValueOnce(env)

    const fake = createFakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    await runAdd({ label: 'work-mac' })

    // Phase 1: subprocess orchestration.
    expect(addAccountInteractive).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledOnce()
    expect(exportAccount).toHaveBeenCalledWith(1)

    // Phase 2: dispatch — exactly one action call to the typed
    // `upsertFromPlaintext` ref (NOT a string-keyed proxy).
    expect(fake.action).toHaveBeenCalledOnce()
    const call = getCall(fake.action, 0)
    expect(refName(call.ref)).toBe(getFunctionName(api.subscriptions.actions.upsertFromPlaintext))

    const payload = call.args ?? {}
    expect(payload.email).toBe('work@example.com')
    expect(payload.subscriptionType).toBe('max')
    expect(payload.rateLimitTier).toBe('tier1')
    expect(payload.expiresAt).toBe(1_900_000_000_000)
    expect(payload.label).toBe('work-mac')

    // The plaintext blob must be JSON of `{claudeAiOauth: {...}}`. Critically,
    // it must NOT contain anything that looks like the AES master key — the
    // CLI never holds VAULT_AES_KEY (encryption happens server-side).
    expect(typeof payload.plaintextBlob).toBe('string')
    const blob = payload.plaintextBlob as string
    expect(blob).not.toMatch(/VAULT_AES_KEY/i)
    expect(blob).not.toMatch(/\bnonce\b/i)
    const parsed = JSON.parse(blob) as { claudeAiOauth: Record<string, unknown> }
    expect(parsed.claudeAiOauth).toBeDefined()
    expect(parsed.claudeAiOauth.accessToken).toMatch(/^sk-ant-oat01-/)
    expect(parsed.claudeAiOauth.refreshToken).toMatch(/^sk-ant-ort01-/)

    // Round-trip: `cvault list` reads the row back via `listForUser`. The
    // fake's `listForUser` handler mirrors the real one — strips ciphertext
    // / nonce / plaintextBlob and returns metadata only.
    vi.mocked(status).mockReturnValueOnce('Active account: 1 (work@example.com)\n')
    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })
    await runList()
    const out = captured.join('\n')
    expect(out).toContain('work@example.com')
    expect(out).toContain('work-mac') // the label we passed in
    expect(out).not.toContain('sk-ant-') // metadata only — no plaintext leak
  })

  it('omits `label` from the dispatched payload when not supplied', async () => {
    vi.mocked(status).mockReturnValueOnce('Active account: 1 (a@b.com)\n')
    vi.mocked(exportAccount).mockReturnValueOnce(singleAccountEnvelope({ number: 1, email: 'a@b.com' }))
    const fake = createFakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)

    await runAdd({})

    const payload = getCall(fake.action, 0).args ?? {}
    expect(payload.label).toBeUndefined()
  })
})
