/**
 * Scenario #4 — Switch on the same machine.
 *
 * Plan: docs/research/scenario-tests-plan.md §4.4.
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7
 *  (pull-on-use semantics) + §5 (`pullForSwitch`).
 *
 * What this scenario covers end-to-end:
 *  - The local Keychain is already up-to-date for this sub: the
 *    `~/.vault/last-hash-{email}.txt` file matches the server's
 *    `contentHash` returned by `pullForSwitch`
 *  - In that case `runSwitch` MUST NOT call `claude-swap --import -`
 *    (skipping the redundant Keychain rewrite is the whole point of the
 *    hash short-circuit)
 *  - It MUST still call `claude-swap --switch-to <slot>` so the active
 *    Claude Code identity flips
 *  - It dispatches the typed `pullForSwitch` action ref
 *  - Server-side, the fake's `pullForSwitch` records a `machineActivity`
 *    row with `action: 'pull'` and the active Clerk session id
 *
 * Note on `action='pull'` vs `action='switch'`: the shipped backend
 * inserts `'pull'` from `pullForSwitch` (see
 * convex/subscriptions/actions.ts line 83). The user task brief and spec
 * §5 both list 'switch' too, but the deviation between brief and impl
 * is a Stefan call (plan §8 deviation #2). This scenario asserts what
 * the shipped code does so it doesn't fight the impl.
 */
import { writeFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getFunctionName } from 'convex/server'
import { api } from '@cvault/convex/api'

vi.mock('../../src/claudeSwap', () => ({
  importEnvelope: vi.fn(),
  switchTo: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

import { importEnvelope, switchTo } from '../../src/claudeSwap'
import { runSwitch } from '../../src/commands/switch'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { ensureVaultDir, lastHashPath } from '../../src/paths'
import {
  cleanupTempHome,
  createFakeVaultClient,
  getCall,
  makeSub,
  refName,
  SAMPLE_OAUTH_BLOB,
  setupTempHome,
} from './_helpers'

let tempHome: string

beforeEach(() => {
  tempHome = setupTempHome('cvault-switch-same-test-')
})

afterEach(() => {
  cleanupTempHome(tempHome)
})

describe('Scenario #4 — Switch on the same machine (hash matches)', () => {
  it('skips import when local hash matches server hash, still calls switchTo, and logs machineActivity', async () => {
    const sub = await makeSub({
      email: 'a@b.com',
      slot: 1,
      plaintextBlob: SAMPLE_OAUTH_BLOB,
    })
    const fake = createFakeVaultClient({
      subscriptions: [sub],
      clerkSessionId: 'sess_machine_1',
    })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)

    // Pre-populate the local hash file so it matches the server's hash.
    await ensureVaultDir()
    writeFileSync(lastHashPath('a@b.com'), sub.contentHash, { mode: 0o600 })

    await runSwitch({ slotOrEmail: '1' })

    // Dispatch: typed pullForSwitch ref.
    expect(fake.action).toHaveBeenCalledOnce()
    const call = getCall(fake.action, 0)
    expect(refName(call.ref)).toBe(
      getFunctionName(api.subscriptions.actions.pullForSwitch)
    )
    expect(call.args?.slotOrEmail).toBe('1')

    // Hash matched -> no claude-swap --import -.
    expect(importEnvelope).not.toHaveBeenCalled()
    // But we still flip the active slot.
    expect(switchTo).toHaveBeenCalledWith(1)

    // The fake's `pullForSwitch` recorded a machineActivity row with
    // action='pull' (mirror of convex/subscriptions/actions.ts line 83).
    expect(fake.state.machineActivity.length).toBe(1)
    const row = fake.state.machineActivity[0]!
    expect(row.action).toBe('pull')
    expect(row.subscriptionId).toBe(sub._id)
    expect(row.userId).toBe(sub.userId)
    // The clerkSessionId stamp identifies which machine performed the pull.
    expect(row.clerkSessionId).toBe('sess_machine_1')
    expect(row.clerkSessionId.length).toBeGreaterThan(0)
  })

  it('imports when the local hash is missing (first switch on this machine for this sub)', async () => {
    const sub = await makeSub({
      email: 'fresh@b.com',
      slot: 2,
      plaintextBlob: SAMPLE_OAUTH_BLOB,
    })
    const fake = createFakeVaultClient({ subscriptions: [sub] })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)

    // No hash file pre-written -> mismatch -> import.
    await runSwitch({ slotOrEmail: 'fresh@b.com' })

    expect(importEnvelope).toHaveBeenCalledOnce()
    const env = vi.mocked(importEnvelope).mock.calls[0]?.[0]
    expect(env?.accounts[0]?.email).toBe('fresh@b.com')
    // The envelope carries the OAuth blob the fake handed back.
    expect(env?.accounts[0]?.credentials.claudeAiOauth.accessToken).toBe(
      'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA'
    )
    expect(switchTo).toHaveBeenCalledWith(2)
  })
})
