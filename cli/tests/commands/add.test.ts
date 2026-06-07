/**
 * Spec: §7 — `cvault add`.
 *
 * `add` is a non-destructive snapshot of the currently-active Claude
 * Code login: read keychain + claude.json, build envelope, upload to
 * Convex. No `claude auth login` spawn (that surprised users by
 * replacing the cred they wanted to capture).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runAdd } from '../../src/commands/add'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { exportAccount, getActiveAccount, importEnvelope } from '../../src/credentials'
import { singleAccountEnvelope } from '../fixtures/envelopes/singleAccount'
import { noopWithMachineLabel, noopWithMeta } from '../scenarios/_helpers'

vi.mock('../../src/credentials', () => ({
  exportAccount: vi.fn(),
  getActiveAccount: vi.fn(),
  importEnvelope: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

beforeEach(() => {
  vi.mocked(getActiveAccount).mockReset()
  vi.mocked(exportAccount).mockReset()
  vi.mocked(makeVaultClient).mockReset()
  vi.mocked(importEnvelope).mockReset()
  vi.mocked(importEnvelope).mockResolvedValue(undefined)
})

interface FakeClient {
  action: ReturnType<typeof vi.fn>
}

function fakeVaultClient(): FakeClient {
  return {
    action: vi.fn().mockResolvedValue({ subId: 'sub_123', slot: 1, created: true }),
  }
}

describe('runAdd', () => {
  it('reads the active credential, builds an envelope, and uploads to Convex', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'new@example.com' })
    const env = singleAccountEnvelope({ number: 1, email: 'new@example.com' })
    vi.mocked(exportAccount).mockReturnValueOnce(env)
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    await runAdd({ label: 'work-mac' })

    expect(exportAccount).toHaveBeenCalledOnce()
    expect(client.action).toHaveBeenCalledOnce()
    const callArg = client.action.mock.calls[0]?.[1] as Record<string, unknown>
    expect(callArg.email).toBe('new@example.com')
    expect(typeof callArg.plaintextBlob).toBe('string')
    expect(callArg.subscriptionType).toBe('max')
    expect(callArg.label).toBe('work-mac')
    const parsed = JSON.parse(callArg.plaintextBlob as string) as {
      claudeAiOauth: { accessToken: string }
    }
    expect(parsed.claudeAiOauth.accessToken).toBe('sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA')
  })

  it('uploads the REAL refresh token but neuters the LOCAL keychain afterward', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'new@example.com' })
    vi.mocked(exportAccount).mockReturnValueOnce(singleAccountEnvelope({ number: 1, email: 'new@example.com' }))
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    await runAdd({})

    // The vault receives the REAL refresh token (it is the sole refresher).
    const uploadArg = client.action.mock.calls[0]?.[1] as Record<string, unknown>
    const uploaded = JSON.parse(uploadArg.plaintextBlob as string) as {
      claudeAiOauth: { refreshToken: string }
    }
    expect(uploaded.claudeAiOauth.refreshToken).toBe('sk-ant-ort01-BBBBBBBBBBBBBBBBBBBB')

    // The local keychain is re-written with a NEUTERED token so this machine
    // can never rotate the shared grant — but the access token is preserved.
    expect(importEnvelope).toHaveBeenCalledOnce()
    const written = vi.mocked(importEnvelope).mock.calls[0]?.[0]
    expect(written?.accounts[0]?.credentials.claudeAiOauth.refreshToken).toBe('cvault-neutered-no-refresh')
    expect(written?.accounts[0]?.credentials.claudeAiOauth.accessToken).toBe('sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA')
  })

  it('neuters AFTER a successful upload (never leaves a real RT local if the upload failed)', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'q@z.com' })
    vi.mocked(exportAccount).mockReturnValueOnce(singleAccountEnvelope({ number: 1, email: 'q@z.com' }))
    const client: FakeClient = { action: vi.fn().mockRejectedValue(new Error('convex down')) }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    await expect(runAdd({})).rejects.toThrow(/convex down/)
    // Upload failed → we must NOT have written anything (real or neutered) locally.
    expect(importEnvelope).not.toHaveBeenCalled()
  })

  it('omits `label` when not supplied', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'a@b.com' })
    vi.mocked(exportAccount).mockReturnValueOnce(singleAccountEnvelope({ number: 1, email: 'a@b.com' }))
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    await runAdd({})

    const callArg = client.action.mock.calls[0]?.[1] as Record<string, unknown>
    expect(callArg.label).toBeUndefined()
  })

  it('passes the access-token expiry through to Convex (ms epoch)', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'x@y.com' })
    const env = singleAccountEnvelope({ number: 2, email: 'x@y.com' })
    env.accounts[0]!.credentials.claudeAiOauth.expiresAt = 1_900_000_000_000
    vi.mocked(exportAccount).mockReturnValueOnce(env)
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    await runAdd({})

    const callArg = client.action.mock.calls[0]?.[1] as Record<string, unknown>
    expect(callArg.expiresAt).toBe(1_900_000_000_000)
  })

  it('throws a clear hint when no active account exists', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)
    await expect(runAdd({})).rejects.toThrow(/claude auth login/i)
    // Must not have touched the vault client at all.
    expect(makeVaultClient).not.toHaveBeenCalled()
  })

  it('refuses to upload a neutered (vault-managed) credential and never hits the vault', async () => {
    // After `cvault switch`/`pull` this machine's keychain holds the dead
    // sentinel in place of a real refresh token. Re-`add`ing it would poison
    // the vault, so we must bail BEFORE the network round-trip.
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'shared@example.com' })
    const env = singleAccountEnvelope({ number: 1, email: 'shared@example.com' })
    env.accounts[0]!.credentials.claudeAiOauth.refreshToken = 'cvault-neutered-no-refresh'
    vi.mocked(exportAccount).mockReturnValueOnce(env)

    await expect(runAdd({})).rejects.toThrow(/neuter/i)
    expect(makeVaultClient).not.toHaveBeenCalled()
  })
})
