/**
 * Spec: §7 — `cvault status [--slot <slot>] [--all] [--json]`.
 *
 * Diagnostic command. Prints a comparison of local Keychain state vs
 * the vault state for a single sub (default: the active local sub,
 * resolved by email) or every sub (--all). `--json` emits a structured
 * payload for scripting; the human form is the default.
 *
 * The CLI calls `subscriptions.queries.getStatus({ slot })` per sub.
 * It does NOT mutate; this is a read-only surface used to decide
 * whether to invoke `cvault refresh`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runStatus } from '../../src/commands/status'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { getActiveAccount } from '../../src/credentials'
import { readCredentials } from '../../src/native/credentialStore'
import { noopWithMachineLabel } from '../scenarios/_helpers'

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

vi.mock('../../src/credentials', () => ({
  getActiveAccount: vi.fn(),
}))

vi.mock('../../src/native/credentialStore', () => ({
  readCredentials: vi.fn(),
}))

const SAMPLE_LOCAL_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-LOCAL-AAAAAAAAAAAAAAAA',
    refreshToken: 'sk-ant-ort01-h8LT8x65MpV-LOCAL-BBBBBBBBBBB',
    expiresAt: 1_900_000_000_000,
    scopes: ['user:inference'],
  },
})

const NOW = 1_900_000_000_000
const TWO_HOURS_MS = 2 * 60 * 60 * 1000

beforeEach(() => {
  vi.mocked(makeVaultClient).mockReset()
  vi.mocked(getActiveAccount).mockReset()
  vi.mocked(readCredentials).mockReset()
  // Pin Date.now to NOW so the relative-time math + the
  // `refreshExpiresAt <= now` reloginRequired check are deterministic
  // regardless of when the test runs.
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runStatus', () => {
  it('prints "no active account" when there is no local sub and no --slot/--all flag', async () => {
    vi.mocked(getActiveAccount).mockReturnValue(null)
    vi.mocked(readCredentials).mockReturnValue(null)
    vi.mocked(makeVaultClient).mockResolvedValue({ query: vi.fn() } as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runStatus({})
    expect(captured.join('\n')).toMatch(/no active|sign in|cvault add/i)
  })

  it('shows local + vault state side-by-side when in sync', async () => {
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'sync@example.com' })
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)

    const client = {
      query: vi.fn(),
    }
    // First query — listForUser to find slot for the active email.
    client.query.mockResolvedValueOnce([{ _id: 'sub_1', slot: 1, email: 'sync@example.com' }])
    // Second query — getStatus.
    client.query.mockResolvedValueOnce({
      sub: {
        _id: 'sub_1',
        slot: 1,
        email: 'sync@example.com',
        expiresAt: 1_900_000_000_000,
        lastRefreshedAt: 1_900_000_000_000 - 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      },
      refreshLog: [{ outcome: 'success', triggeredBy: 'cron', at: 1_900_000_000_000 - 60_000 }],
      lastMachineActivity: { action: 'switch', clerkSessionId: 'sess_1', at: 1_900_000_000_000 - 5 * 60_000 },
    })
    vi.mocked(makeVaultClient).mockResolvedValue({ ...client, withMachineLabel: noopWithMachineLabel } as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runStatus({})
    const out = captured.join('\n')
    expect(out).toContain('sync@example.com')
    expect(out.toLowerCase()).toContain('local')
    expect(out.toLowerCase()).toContain('vault')
    // Drift label says "none" or similar when in sync.
    expect(out.toLowerCase()).toMatch(/none|in sync|matches/)
  })

  it('reports "vault newer" when vault expiresAt is greater than local', async () => {
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'drift@example.com' })
    // Local blob with expiresAt = NOW.
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)

    const vaultExpires = NOW + TWO_HOURS_MS
    const client = {
      query: vi.fn(),
    }
    client.query.mockResolvedValueOnce([{ _id: 'sub_2', slot: 2, email: 'drift@example.com' }])
    client.query.mockResolvedValueOnce({
      sub: {
        _id: 'sub_2',
        slot: 2,
        email: 'drift@example.com',
        expiresAt: vaultExpires,
        lastRefreshedAt: NOW - 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      },
      refreshLog: [],
      lastMachineActivity: null,
    })
    vi.mocked(makeVaultClient).mockResolvedValue({ ...client, withMachineLabel: noopWithMachineLabel } as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runStatus({})
    const out = captured.join('\n')
    expect(out.toLowerCase()).toMatch(/vault.*newer|vault is newer/)
  })

  it('shows a relogin hint when the vault row has refreshExpiresAt set', async () => {
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'dead@example.com' })
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)

    const client = {
      query: vi.fn(),
    }
    client.query.mockResolvedValueOnce([{ _id: 'sub_3', slot: 3, email: 'dead@example.com' }])
    client.query.mockResolvedValueOnce({
      sub: {
        _id: 'sub_3',
        slot: 3,
        email: 'dead@example.com',
        expiresAt: NOW - 60_000,
        refreshExpiresAt: NOW - 60_000, // already expired → relogin
        lastRefreshedAt: NOW - 24 * 60 * 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      },
      refreshLog: [{ outcome: 'reloginRequired', triggeredBy: 'cron', at: NOW - 60_000 }],
      lastMachineActivity: { action: 'add', clerkSessionId: 'sess_old', at: NOW - 24 * 60 * 60_000 },
    })
    vi.mocked(makeVaultClient).mockResolvedValue({ ...client, withMachineLabel: noopWithMachineLabel } as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runStatus({})
    const out = captured.join('\n')
    expect(out.toLowerCase()).toMatch(/relogin|re-capture|needs re-?capture/)
    expect(out).toMatch(/cvault add/)
  })

  it('iterates all subs when --all is set', async () => {
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'first@example.com' })
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)

    const subs = [
      { _id: 'sub_a', slot: 1, email: 'first@example.com' },
      { _id: 'sub_b', slot: 2, email: 'second@example.com' },
      { _id: 'sub_c', slot: 3, email: 'third@example.com' },
    ]
    const client = {
      query: vi.fn(),
    }
    client.query.mockResolvedValueOnce(subs)
    // One getStatus call per sub.
    for (const s of subs) {
      client.query.mockResolvedValueOnce({
        sub: {
          _id: s._id,
          slot: s.slot,
          email: s.email,
          expiresAt: NOW + TWO_HOURS_MS,
          lastRefreshedAt: NOW - 60_000,
          subscriptionType: 'max',
          rateLimitTier: 'tier1',
        },
        refreshLog: [],
        lastMachineActivity: null,
      })
    }
    vi.mocked(makeVaultClient).mockResolvedValue({ ...client, withMachineLabel: noopWithMachineLabel } as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runStatus({ all: true })
    const out = captured.join('\n')
    expect(out).toContain('first@example.com')
    expect(out).toContain('second@example.com')
    expect(out).toContain('third@example.com')
  })

  it('emits structured JSON when --json is set', async () => {
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'json@example.com' })
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)

    const client = {
      query: vi.fn(),
    }
    client.query.mockResolvedValueOnce([{ _id: 'sub_j', slot: 4, email: 'json@example.com' }])
    client.query.mockResolvedValueOnce({
      sub: {
        _id: 'sub_j',
        slot: 4,
        email: 'json@example.com',
        expiresAt: NOW + TWO_HOURS_MS,
        lastRefreshedAt: NOW - 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      },
      refreshLog: [],
      lastMachineActivity: null,
    })
    vi.mocked(makeVaultClient).mockResolvedValue({ ...client, withMachineLabel: noopWithMachineLabel } as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runStatus({ json: true })
    const out = captured.join('\n')
    // Output must parse as JSON.
    expect(() => JSON.parse(out)).not.toThrow()
    const parsed = JSON.parse(out) as Array<{ email: string; slot: number; drift: string }>
    expect(parsed[0]?.email).toBe('json@example.com')
    expect(parsed[0]?.slot).toBe(4)
    // The drift summary string is part of the JSON contract.
    expect(typeof parsed[0]?.drift).toBe('string')
  })

  it('uses --slot when provided to bypass the active-email lookup', async () => {
    vi.mocked(getActiveAccount).mockReturnValue(null) // no active local
    vi.mocked(readCredentials).mockReturnValue(null)

    const client = {
      query: vi.fn(),
    }
    // No listForUser call when slot is explicit; just getStatus.
    client.query.mockResolvedValueOnce({
      sub: {
        _id: 'sub_specific',
        slot: 7,
        email: 'explicit@example.com',
        expiresAt: NOW + TWO_HOURS_MS,
        lastRefreshedAt: NOW - 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      },
      refreshLog: [],
      lastMachineActivity: null,
    })
    vi.mocked(makeVaultClient).mockResolvedValue({ ...client, withMachineLabel: noopWithMachineLabel } as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runStatus({ slot: 7 })
    const out = captured.join('\n')
    expect(out).toContain('explicit@example.com')
    expect(out).toContain('7')
  })
})
