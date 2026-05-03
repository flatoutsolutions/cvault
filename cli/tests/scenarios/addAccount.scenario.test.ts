/**
 * Scenario #2 — Add account flow (`cvault add`).
 *
 * Plan: docs/research/scenario-tests-plan.md §4.2.
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5
 *  + §6 (encryption envelope) + §7 (`cvault add`).
 *
 * `cvault add` is non-destructive (commit 0f21b97): it snapshots the
 * already-active Claude Code login on this machine — it does NOT spawn
 * `claude auth login`. Earlier scenarios stubbed an interactive spawn;
 * the current contract requires an active account to exist before
 * `runAdd` is invoked, otherwise the command throws a hint to run
 * `claude auth login` first.
 *
 * What this scenario covers end-to-end:
 *  - `runAdd` reads the active credential via `getActiveAccount` and
 *    builds an envelope from the on-disk Keychain + `~/.claude.json`.
 *  - The captured plaintext blob is dispatched to the typed
 *    `api.subscriptions.actions.upsertFromPlaintext` action.
 *  - The dispatched payload contains:
 *      * the parsed email
 *      * the JSON-stringified `claudeAiOauth` blob (no extra wrappers)
 *      * `expiresAt`, `subscriptionType`, `rateLimitTier`, optional `label`
 *  - A follow-up `runList` reads the newly-stored sub back via
 *    `listForUser` (round-trip wire shape — strips ciphertext / nonce).
 *  - The fake backend's stored row never contains the AES master key and
 *    its `plaintextBlob` deserializes to the same OAuth tokens we sent.
 *  - `addAccountInteractive` (the `claude auth login` spawn) is NEVER
 *    invoked — guarding against regressing the non-destructive contract.
 *
 * What's stubbed:
 *  - `getActiveAccount` / `exportAccount` — the on-disk active sub.
 *  - `addAccountInteractive` — pinned as un-called (defense-in-depth).
 *  - `makeVaultClient` — wired to the in-memory `FakeVaultClient`.
 */
import { api } from '@cvault/convex/api'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runAdd } from '../../src/commands/add'
import { runList } from '../../src/commands/list'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { addAccountInteractive, exportAccount, getActiveAccount } from '../../src/credentials'
import { singleAccountEnvelope } from '../fixtures/envelopes/singleAccount'
import { cleanupTempHome, createFakeVaultClient, getCall, refName, setupTempHome } from './_helpers'

vi.mock('../../src/credentials', () => ({
  addAccountInteractive: vi.fn().mockResolvedValue(undefined),
  exportAccount: vi.fn(),
  getActiveAccount: vi.fn(),
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
  it('reads the active credential, dispatches typed upsertFromPlaintext, and the row reads back via listForUser', async () => {
    // M7 hardening (commit 0f21b97): runAdd throws if no active account
    // exists on this machine. The mock seeds the active sub `runAdd`
    // will snapshot — same email the fixture envelope below carries.
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'work@example.com' })
    const env = singleAccountEnvelope({ number: 1, email: 'work@example.com' })
    env.accounts[0]!.credentials.claudeAiOauth.expiresAt = 1_900_000_000_000
    vi.mocked(exportAccount).mockReturnValueOnce(env)

    const fake = createFakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    await runAdd({ label: 'work-mac' })

    // Phase 1: snapshot — we read the active credential, build an
    // envelope. The non-destructive contract demands we NEVER spawn
    // `claude auth login` from `add` (regression guard for 0f21b97).
    expect(addAccountInteractive).not.toHaveBeenCalled()
    expect(exportAccount).toHaveBeenCalledOnce()

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
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'work@example.com' })
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
    // Active account must exist for runAdd to proceed (commit 0f21b97).
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'a@b.com' })
    vi.mocked(exportAccount).mockReturnValueOnce(singleAccountEnvelope({ number: 1, email: 'a@b.com' }))
    const fake = createFakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)

    await runAdd({})

    const payload = getCall(fake.action, 0).args ?? {}
    expect(payload.label).toBeUndefined()
  })
})
