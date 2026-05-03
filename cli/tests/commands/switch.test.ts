/**
 * Spec: §7 — `cvault switch <slot|email>`.
 *
 * Pull-on-use semantics:
 *   1. Convex action `pullForSwitch` returns
 *      `{email, slot, plaintextBlob, contentHash}`. Server refreshes the
 *      access token if it's about to expire.
 *   2. Compare `contentHash` against `~/.vault/last-hash-{email}.txt`. If
 *      it matches, skip import (Keychain is already up to date).
 *   3. Mismatch → wrap the plaintext blob in a single-account envelope and
 *      pass via stdin to `claude-swap --import -`. Update the local hash
 *      file.
 *   4. `claude-swap --switch-to <slot>`.
 *
 * Offline degradation:
 *   - Convex unreachable → fall back to local `claude-swap --switch-to`
 *     directly with a printed warning.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runSwitch } from '../../src/commands/switch'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { importEnvelope, switchTo } from '../../src/credentials'
import { ensureVaultDir, lastHashPath } from '../../src/paths'
import { noopWithMachineLabel } from '../scenarios/_helpers'

vi.mock('../../src/credentials', () => ({
  importEnvelope: vi.fn(),
  switchTo: vi.fn(),
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
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-switch-test-'))
  vi.stubEnv('HOME', tempHome)
})

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true })
})

interface FakeClient {
  action: ReturnType<typeof vi.fn>
}

function setupClientReturning(blob: string, contentHash: string): FakeClient {
  const client = {
    action: vi.fn().mockResolvedValue({
      email: 'a@b.com',
      slot: 1,
      plaintextBlob: blob,
      contentHash,
    }),
  }
  vi.mocked(makeVaultClient).mockResolvedValueOnce({ ...client, withMachineLabel: noopWithMachineLabel } as never)
  return client
}

describe('runSwitch — fresh switch (no local hash)', () => {
  it('pulls, imports, and writes hash (switchTo is no longer called)', async () => {
    setupClientReturning(SAMPLE_BLOB, 'hash-abc')

    await runSwitch({ slotOrEmail: '1' })

    expect(importEnvelope).toHaveBeenCalledOnce()
    const env = vi.mocked(importEnvelope).mock.calls[0]?.[0]
    expect(env?.accounts[0]?.email).toBe('a@b.com')
    expect(env?.accounts[0]?.credentials.claudeAiOauth.accessToken).toBe('sk-ant-oat01-abc')

    // On native, the import IS the switch — no separate `switchTo` step.
    expect(switchTo).not.toHaveBeenCalled()

    // Hash file was written
    await ensureVaultDir()
    const path = lastHashPath('a@b.com')
    expect(readFileSync(path, 'utf8')).toBe('hash-abc')
  })
})

describe('runSwitch — hash match', () => {
  it('skips import when local hash matches the server hash', async () => {
    // Pre-populate the hash file so the local cache "matches".
    await ensureVaultDir()
    const path = lastHashPath('a@b.com')
    writeFileSync(path, 'hash-abc', { mode: 0o600 })

    setupClientReturning(SAMPLE_BLOB, 'hash-abc')

    await runSwitch({ slotOrEmail: 'a@b.com' })

    expect(importEnvelope).not.toHaveBeenCalled()
    // Hash matched → no work to do; switchTo isn't called either.
    expect(switchTo).not.toHaveBeenCalled()
  })
})

describe('runSwitch — hash mismatch', () => {
  it('imports the new blob when hashes differ', async () => {
    // Existing local hash is stale.
    await ensureVaultDir()
    const path = lastHashPath('a@b.com')
    writeFileSync(path, 'hash-old', { mode: 0o600 })

    setupClientReturning(SAMPLE_BLOB, 'hash-new')

    await runSwitch({ slotOrEmail: 'a@b.com' })

    expect(importEnvelope).toHaveBeenCalledOnce()
    // No separate switchTo call on native.
    expect(switchTo).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toBe('hash-new')
  })
})

describe('runSwitch — offline behavior (fail loud — M6)', () => {
  it('throws an OfflineError when Convex is unreachable (DNS failure)', async () => {
    vi.mocked(makeVaultClient).mockRejectedValueOnce(
      new Error('fetch failed: getaddrinfo ENOTFOUND beloved-mouse-707.convex.cloud')
    )

    await expect(runSwitch({ slotOrEmail: '2' })).rejects.toThrow(/Convex.*unreachable|cannot rotate/i)

    expect(importEnvelope).not.toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('throws an OfflineError when the Convex action call rejects with a network error', async () => {
    const client = {
      action: vi.fn().mockRejectedValueOnce(new Error('fetch failed: connection refused')),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({ ...client, withMachineLabel: noopWithMachineLabel } as never)

    await expect(runSwitch({ slotOrEmail: '2' })).rejects.toThrow(/Convex.*unreachable|cannot rotate/i)
    expect(importEnvelope).not.toHaveBeenCalled()
  })

  it('does not swallow non-network errors from Convex', async () => {
    const client = {
      action: vi.fn().mockRejectedValueOnce(new Error('500 InternalError: VAULT_AES_KEY missing')),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({ ...client, withMachineLabel: noopWithMachineLabel } as never)

    await expect(runSwitch({ slotOrEmail: '2' })).rejects.toThrow(/VAULT_AES_KEY/)
    expect(switchTo).not.toHaveBeenCalled()
  })
})
