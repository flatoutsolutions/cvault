import { afterEach, describe, expect, it, vi } from 'vitest'

import { pullCommand, runPull } from '../../src/commands/pull'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { getActiveAccount, importEnvelope } from '../../src/credentials'
import { readCredentials } from '../../src/native/credentialStore'

vi.mock('../../src/convex/vaultClient')
vi.mock('../../src/native/credentialStore')
vi.mock('../../src/credentials')

afterEach(() => vi.clearAllMocks())

function fakeClient(action: ReturnType<typeof vi.fn>) {
  return { action, withMeta: (a: Record<string, unknown>) => a } as unknown as Awaited<
    ReturnType<typeof makeVaultClient>
  >
}

describe('runPull', () => {
  it('skips the network when the local token is still fresh', async () => {
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'a@b.com' })
    vi.mocked(readCredentials).mockReturnValue(
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60 * 60 * 1000 } })
    )
    const action = vi.fn()
    vi.mocked(makeVaultClient).mockResolvedValue(fakeClient(action))

    await runPull()

    expect(action).not.toHaveBeenCalled()
    expect(importEnvelope).not.toHaveBeenCalled()
  })

  it('pulls a NEUTERED token and writes it when the local token is near expiry', async () => {
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'a@b.com' })
    vi.mocked(readCredentials).mockReturnValue(JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60 * 1000 } }))
    const action = vi.fn().mockResolvedValue({
      email: 'a@b.com',
      slot: 1,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'NEW',
          refreshToken: 'cvault-neutered-no-refresh',
          expiresAt: 0,
          scopes: [],
          subscriptionType: 'max',
        },
      }),
      contentHash: 'h',
    })
    vi.mocked(makeVaultClient).mockResolvedValue(fakeClient(action))

    await runPull()

    expect(action).toHaveBeenCalledWith(
      expect.anything(),
      // silent: the hook runs before every prompt — its pulls must NOT spam
      // the audit trail (server skips the machineActivity row when silent).
      expect.objectContaining({ slotOrEmail: 'a@b.com', neuterRefreshToken: true, silent: true })
    )
    expect(importEnvelope).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when there is no active account', async () => {
    vi.mocked(getActiveAccount).mockReturnValue(null)
    await runPull()
    expect(importEnvelope).not.toHaveBeenCalled()
  })

  it('pulls from the network when there is no usable local token (missing/malformed)', async () => {
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'a@b.com' })
    vi.mocked(readCredentials).mockReturnValue(null) // no local creds → cannot prove freshness → must pull
    const action = vi.fn().mockResolvedValue({
      email: 'a@b.com',
      slot: 1,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'NEW',
          refreshToken: 'cvault-neutered-no-refresh',
          expiresAt: 0,
          scopes: [],
          subscriptionType: 'max',
        },
      }),
      contentHash: 'h',
    })
    vi.mocked(makeVaultClient).mockResolvedValue(fakeClient(action))

    await runPull()

    expect(action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ neuterRefreshToken: true, silent: true })
    )
    expect(importEnvelope).toHaveBeenCalledTimes(1)
  })
})

describe('pullCommand (hot path — must never block the prompt)', () => {
  it('swallows errors so the UserPromptSubmit hook never fails the prompt', async () => {
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'a@b.com' })
    vi.mocked(readCredentials).mockReturnValue(null)
    const action = vi.fn().mockRejectedValue(new Error('convex unreachable'))
    vi.mocked(makeVaultClient).mockResolvedValue(fakeClient(action))

    const ctx = { rawArgs: [], args: {}, cmd: pullCommand, data: undefined } as unknown as Parameters<
      NonNullable<typeof pullCommand.run>
    >[0]

    await expect(pullCommand.run!(ctx)).resolves.toBeUndefined()
    expect(importEnvelope).not.toHaveBeenCalled()
  })
})
