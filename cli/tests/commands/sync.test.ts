/**
 * Spec: §7 — `cvault sync --all`.
 *
 * Bootstrap on a fresh machine: pull every sub from Convex, import each
 * into the local Keychain. Equivalent to running `cvault switch` for
 * every sub but in one round-trip.
 *
 * The dispatch is per-sub: for each sub returned by `listForUser`, we
 * call the same `pullForSwitch` action used by `cvault switch`, then
 * `claude-swap --import -` for each. We do NOT call `claude-swap
 * --switch-to` at the end — the user picks the active sub afterward.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runSync } from '../../src/commands/sync'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { importEnvelope } from '../../src/credentials'

vi.mock('../../src/credentials', () => ({
  importEnvelope: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

const SAMPLE_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-abc',
    refreshToken: 'sk-ant-ort01-def',
    expiresAt: 1_900_000_000_000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
})

let tempHome: string

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-sync-test-'))
  vi.stubEnv('HOME', tempHome)
})

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true })
})

describe('runSync', () => {
  it('imports every sub returned by listForUser', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([
        { slot: 1, email: 'a@b.com' },
        { slot: 2, email: 'c@d.com' },
      ]),
      action: vi.fn(),
    }
    client.action
      .mockResolvedValueOnce({
        email: 'a@b.com',
        slot: 1,
        plaintextBlob: SAMPLE_BLOB,
        contentHash: 'h1',
      })
      .mockResolvedValueOnce({
        email: 'c@d.com',
        slot: 2,
        plaintextBlob: SAMPLE_BLOB,
        contentHash: 'h2',
      })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runSync()

    expect(client.query).toHaveBeenCalledOnce()
    expect(client.action).toHaveBeenCalledTimes(2)
    expect(importEnvelope).toHaveBeenCalledTimes(2)
  })

  it('continues importing remaining subs even if one fails', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([
        { slot: 1, email: 'a@b.com' },
        { slot: 2, email: 'c@d.com' },
      ]),
      action: vi.fn(),
    }
    client.action
      .mockResolvedValueOnce({
        email: 'a@b.com',
        slot: 1,
        plaintextBlob: SAMPLE_BLOB,
        contentHash: 'h1',
      })
      .mockRejectedValueOnce(new Error('refresh token expired'))
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await runSync()

    expect(importEnvelope).toHaveBeenCalledOnce()
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/c@d\.com.*refresh/i))
    errSpy.mockRestore()
  })

  it('prints a friendly message when there are no subs', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([]),
      action: vi.fn(),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await runSync()
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/no subscriptions/i))
    expect(client.action).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })
})
