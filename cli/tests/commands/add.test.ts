/**
 * Spec: §7 — `cvault add`.
 *
 * Two-phase flow:
 *   1. `claude-swap --add-account` (interactive — passthrough stdio)
 *   2. `claude-swap --status` to learn the new active slot
 *   3. `claude-swap --export - --account <slot>` to capture credentials
 *   4. POST plaintext to Convex via `api.subscriptions.actions.upsertFromPlaintext`
 *      (PENDING: team-lead must add this public action — current
 *      `subscriptions.mutations.upsert` takes ciphertext+nonce, which the
 *      CLI can't generate without the AES master key)
 *
 * We mock claude-swap helpers + the VaultClient so the test never spawns
 * a subprocess and never hits Convex.
 */
import { describe, expect, it, vi } from 'vitest'

import { addAccountInteractive, exportAccount, status } from '../../src/claudeSwap'
import { runAdd } from '../../src/commands/add'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { singleAccountEnvelope } from '../fixtures/envelopes/singleAccount'

vi.mock('../../src/claudeSwap', () => ({
  addAccountInteractive: vi.fn().mockResolvedValue(undefined),
  status: vi.fn(),
  exportAccount: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

interface FakeClient {
  action: ReturnType<typeof vi.fn>
}

function fakeVaultClient(): FakeClient {
  return {
    action: vi.fn().mockResolvedValue({ subId: 'sub_123', slot: 1, created: true }),
  }
}

describe('runAdd', () => {
  it('runs --add-account, finds the new slot via --status, exports it, and uploads to Convex', async () => {
    vi.mocked(status).mockReturnValueOnce('Active account: 3 (new@example.com)\n')
    const env = singleAccountEnvelope({ number: 3, email: 'new@example.com' })
    vi.mocked(exportAccount).mockReturnValueOnce(env)
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runAdd({ label: 'work-mac' })

    expect(addAccountInteractive).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledOnce()
    expect(exportAccount).toHaveBeenCalledWith(3)
    expect(client.action).toHaveBeenCalledOnce()
    const callArg = client.action.mock.calls[0]?.[1] as Record<string, unknown>
    expect(callArg.email).toBe('new@example.com')
    expect(typeof callArg.plaintextBlob).toBe('string')
    expect(callArg.subscriptionType).toBe('max')
    expect(callArg.label).toBe('work-mac')
    // The plaintextBlob should be JSON parseable and contain the OAuth blob.
    const parsed = JSON.parse(callArg.plaintextBlob as string) as {
      claudeAiOauth: { accessToken: string }
    }
    expect(parsed.claudeAiOauth.accessToken).toBe('sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA')
  })

  it('omits `label` when not supplied', async () => {
    vi.mocked(status).mockReturnValueOnce('Active account: 1 (a@b.com)\n')
    vi.mocked(exportAccount).mockReturnValueOnce(singleAccountEnvelope({ number: 1, email: 'a@b.com' }))
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runAdd({})

    const callArg = client.action.mock.calls[0]?.[1] as Record<string, unknown>
    expect(callArg.label).toBeUndefined()
  })

  it('throws a clear error when claude-swap --status output cannot be parsed for the new slot', async () => {
    vi.mocked(status).mockReturnValueOnce('No active account')
    await expect(runAdd({})).rejects.toThrow(/active slot/i)
  })

  // Pinning the real `claude-swap --status` output format. Verified against
  // an installed claude-swap binary on 2026-05-02. If this regresses, an
  // upstream format change is the likely culprit — update both
  // `parseActiveSlot` regexes (add.ts + list.ts) in lock-step.
  it('parses real claude-swap --status output with `Status: Account-N` prefix', async () => {
    vi.mocked(status).mockReturnValueOnce(
      'Status: Account-1 (samuel.asseg@gmail.com [Org Name])\n  Total managed accounts: 2\n'
    )
    vi.mocked(exportAccount).mockReturnValueOnce(singleAccountEnvelope({ number: 1, email: 'samuel.asseg@gmail.com' }))
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runAdd({})

    expect(exportAccount).toHaveBeenCalledWith(1)
  })

  it('passes the access-token expiry through to Convex (ms epoch)', async () => {
    vi.mocked(status).mockReturnValueOnce('Active account: 2 (x@y.com)\n')
    const env = singleAccountEnvelope({ number: 2, email: 'x@y.com' })
    env.accounts[0]!.credentials.claudeAiOauth.expiresAt = 1_900_000_000_000
    vi.mocked(exportAccount).mockReturnValueOnce(env)
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runAdd({})

    const callArg = client.action.mock.calls[0]?.[1] as Record<string, unknown>
    expect(callArg.expiresAt).toBe(1_900_000_000_000)
  })
})
