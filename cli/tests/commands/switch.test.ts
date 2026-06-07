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
import { getActiveAccount, importEnvelope, switchTo } from '../../src/credentials'
import { ensureVaultDir, lastHashPath } from '../../src/paths'
import { noopWithMachineLabel, noopWithMeta } from '../scenarios/_helpers'

vi.mock('../../src/credentials', () => ({
  getActiveAccount: vi.fn(),
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
  vi.mocked(makeVaultClient).mockResolvedValueOnce({
    ...client,
    withMachineLabel: noopWithMachineLabel,
    withMeta: noopWithMeta,
  } as never)
  return client
}

describe('runSwitch — fresh switch (no local hash)', () => {
  it('pulls, imports, and writes hash (switchTo is no longer called)', async () => {
    setupClientReturning(SAMPLE_BLOB, 'hash-abc')
    // No active local account yet — `cvault switch` from a clean machine.
    vi.mocked(getActiveAccount).mockReturnValue(null)

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

describe('runSwitch — already-active no-op (hash match + email already active)', () => {
  it('skips import when local hash matches AND the target email is already active', async () => {
    // Pre-populate the hash file so the local cache "matches".
    await ensureVaultDir()
    const path = lastHashPath('a@b.com')
    writeFileSync(path, 'hash-abc', { mode: 0o600 })

    setupClientReturning(SAMPLE_BLOB, 'hash-abc')
    // Active local account is the same email we're switching to.
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'a@b.com' })

    const captured: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runSwitch({ slotOrEmail: 'a@b.com' })

    // Truly idempotent path: nothing imported.
    expect(importEnvelope).not.toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
    // User-visible message reflects the no-op so they aren't lied to.
    expect(captured.join('\n')).toMatch(/already active/i)
    logSpy.mockRestore()
  })

  it('case-insensitive: Stefan@x.com active, target stefan@x.com → no-op', async () => {
    await ensureVaultDir()
    setupClientReturning(SAMPLE_BLOB, 'hash-abc')
    // Active local account uses different casing than the vault row.
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'Stefan@example.com' })
    // Server returns the lowercased canonical email + matching hash.
    vi.mocked(makeVaultClient).mockReset()
    const client = {
      action: vi.fn().mockResolvedValue({
        email: 'stefan@example.com',
        slot: 1,
        plaintextBlob: SAMPLE_BLOB,
        contentHash: 'hash-abc',
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)
    // Match the hash on disk under the server-canonical (lowercase) email.
    const path = lastHashPath('stefan@example.com')
    writeFileSync(path, 'hash-abc', { mode: 0o600 })

    await runSwitch({ slotOrEmail: 'stefan@example.com' })

    expect(importEnvelope).not.toHaveBeenCalled()
  })
})

describe('runSwitch — cross-user switch with hash collision (Bug 1 fix)', () => {
  it('imports even when local last-hash-{target}.txt matches, because target is NOT the active email', async () => {
    // Repro of the prod incident:
    //   - `cvault sync` earlier wrote `last-hash-saad.txt` with saad's hash.
    //   - claude.json's oauthAccount points at samuel (last imported).
    //   - User runs `cvault switch saad@x.com`. Server returns saad's
    //     blob + the SAME hash that's already on disk.
    // Pre-fix: hash matches → import skipped → samuel stays active and
    // the CLI lies "Active credentials are now saad". Post-fix: must
    // detect that saad is NOT currently active and import anyway.
    await ensureVaultDir()
    const saadHashPath = lastHashPath('saad@example.com')
    writeFileSync(saadHashPath, 'hash-shared', { mode: 0o600 })

    vi.mocked(makeVaultClient).mockReset()
    const client = {
      action: vi.fn().mockResolvedValue({
        email: 'saad@example.com',
        slot: 1,
        plaintextBlob: SAMPLE_BLOB,
        contentHash: 'hash-shared',
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)
    // Samuel is the locally active account — different from `pull.email`.
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'samuel@example.com' })

    const captured: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runSwitch({ slotOrEmail: '1' })

    // Import MUST run despite the hash match because the target email
    // is not the active one.
    expect(importEnvelope).toHaveBeenCalledOnce()
    const env = vi.mocked(importEnvelope).mock.calls[0]?.[0]
    expect(env?.accounts[0]?.email).toBe('saad@example.com')
    // Hash is rewritten (no-op in value, but the act of writing is fine).
    expect(readFileSync(saadHashPath, 'utf8')).toBe('hash-shared')
    // Truth-in-output: print the actual switch message, not "already active".
    expect(captured.join('\n')).not.toMatch(/already active/i)
    expect(captured.join('\n')).toMatch(/active credentials are now/i)
    logSpy.mockRestore()
  })
})

describe('runSwitch — hash mismatch', () => {
  it('imports the new blob when hashes differ (regardless of active email)', async () => {
    // Existing local hash is stale.
    await ensureVaultDir()
    const path = lastHashPath('a@b.com')
    writeFileSync(path, 'hash-old', { mode: 0o600 })

    setupClientReturning(SAMPLE_BLOB, 'hash-new')
    // Even when the target is already locally active, a hash mismatch
    // means the vault has fresher tokens — import to pick them up.
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'a@b.com' })

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
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    await expect(runSwitch({ slotOrEmail: '2' })).rejects.toThrow(/Convex.*unreachable|cannot rotate/i)
    expect(importEnvelope).not.toHaveBeenCalled()
  })

  it('does not swallow non-network errors from Convex', async () => {
    const client = {
      action: vi.fn().mockRejectedValueOnce(new Error('500 InternalError: VAULT_AES_KEY missing')),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    await expect(runSwitch({ slotOrEmail: '2' })).rejects.toThrow(/VAULT_AES_KEY/)
    expect(switchTo).not.toHaveBeenCalled()
  })
})
