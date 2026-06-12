/**
 * Spec: §7 — `cvault list`.
 *
 * Calls `api.subscriptions.queries.listForUser`, then
 * `getActiveAccount()` to learn which sub is currently active locally,
 * then renders a table. The active marker is keyed off EMAIL not slot
 * (slot numbers are owned by Convex; emails are stable across machines
 * and renumbers).
 */
import { describe, expect, it, vi } from 'vitest'

import { runList } from '../../src/commands/list'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { getActiveAccount } from '../../src/credentials'
import { noopWithMachineLabel, noopWithMeta } from '../scenarios/_helpers'

vi.mock('../../src/credentials', () => ({
  getActiveAccount: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

interface ConvexMeta {
  _id: string
  _creationTime: number
  userId: string
  email: string
  slot: number
  label?: string | undefined
  expiresAt: number
  refreshExpiresAt?: number | undefined
  subscriptionType: string
  rateLimitTier: string
  lastRefreshedAt: number
  // Mirror the wire union: active window, idle marker, or absent.
  usage5h?: { pct: number; resetsAt: number; fetchedAt: number } | { idle: true; fetchedAt: number } | undefined
  usage7d?: { pct: number; resetsAt: number; fetchedAt: number } | { idle: true; fetchedAt: number } | undefined
  removedAt?: number | undefined
}

function meta(overrides: Partial<ConvexMeta> = {}): ConvexMeta {
  return {
    _id: 'sub_abc' as const,
    _creationTime: 1_700_000_000_000,
    userId: 'u1',
    email: 'a@b.com',
    slot: 1,
    expiresAt: 1_700_000_000_000 + 60_000,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
    lastRefreshedAt: 1_700_000_000_000,
    usage5h: { pct: 12, resetsAt: 0, fetchedAt: 0 },
    usage7d: { pct: 34, resetsAt: 0, fetchedAt: 0 },
    ...overrides,
  }
}

describe('runList', () => {
  it('renders all subs from Convex with the locally-active one marked (matched by email, NOT slot)', async () => {
    // The user's local credentials match c@d.com — which lives at vault slot 2.
    // The active marker must follow the email; the legacy slot-based logic
    // would mark slot 1 as active because `status()` always synthesizes
    // "Account-1". H1 fix: match by email.
    const client = {
      query: vi.fn().mockResolvedValueOnce([meta({ slot: 1, email: 'a@b.com' }), meta({ slot: 2, email: 'c@d.com' })]),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'c@d.com' })

    const captured: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()

    const out = captured.join('\n')
    expect(out).toContain('a@b.com')
    expect(out).toContain('c@d.com')
    // Active line for c@d.com (vault slot 2) should have the asterisk marker
    const lines = out.split('\n')
    const cLine = lines.find((l) => l.includes('c@d.com'))
    expect(cLine).toMatch(/\*/)
    // a@b.com (vault slot 1) must NOT be marked active
    const aLine = lines.find((l) => l.includes('a@b.com'))
    expect(aLine).not.toMatch(/^\*/)
    logSpy.mockRestore()
  })

  it('renders empty-state when user has no subs', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce([]) }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await runList()
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/no subscriptions/i))
    logSpy.mockRestore()
  })

  it('handles missing usage data gracefully', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([meta({ usage5h: undefined, usage7d: undefined })]),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'a@b.com' })

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()
    expect(captured.join('\n')).toMatch(/\s-\s/)
  })

  it('renders an idle 5h window from the server as "ready"', async () => {
    // Exercises the union mapping in list.ts (`'pct' in u` / `'idle' in u`),
    // the consumer most like the original freeze bug. A bare renderSubsTable
    // test bypasses this mapping; this asserts it end-to-end.
    const client = {
      query: vi.fn().mockResolvedValueOnce([meta({ email: 'idle@x.com', usage5h: { idle: true, fetchedAt: 0 } })]),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)

    const captured: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()
    logSpy.mockRestore()

    const line = captured
      .join('\n')
      .split('\n')
      .find((l) => l.includes('idle@x.com'))
    expect(line).toContain('ready')
  })

  it('does not crash if reading the local active account fails', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([meta()]),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)
    vi.mocked(getActiveAccount).mockImplementationOnce(() => {
      throw new Error('keychain locked')
    })

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()
    // Output should still render — just without an active marker.
    expect(captured.join('\n')).toContain('a@b.com')
  })

  it('marks no row active when there is no active local account', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([meta({ slot: 1, email: 'a@b.com' })]),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()
    const lines = captured.join('\n').split('\n')
    const aLine = lines.find((l) => l.includes('a@b.com'))
    expect(aLine).toBeDefined()
    expect(aLine).not.toMatch(/^\*/)
  })

  it('appends a footer explaining the ⚠ marker when at least one sub needs re-capture', async () => {
    // Seed two subs: one healthy, one with refreshExpiresAt clamped
    // to the past (the markReloginRequired internal mutation does
    // exactly this when Anthropic returns invalid_grant).
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce([
          meta({ slot: 1, email: 'ok@example.com' }),
          meta({ slot: 2, email: 'dead@example.com', refreshExpiresAt: Date.now() - 60_000 }),
        ]),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()

    const out = captured.join('\n')
    expect(out).toContain('⚠')
    expect(out).toMatch(/cvault add/)
    expect(out.toLowerCase()).toMatch(/re-?capture|recapture/)
  })

  it('does NOT print the footer when no sub needs re-capture', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([meta({ slot: 1, email: 'healthy@example.com' })]),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()

    expect(captured.join('\n')).not.toMatch(/recapture|re-capture/i)
  })

  it('Bug 2: renders FCFS rank (#) per response order, not the stored slot field', async () => {
    // Real shared-vault scenario: every user's first sub has stored
    // slot=1 server-side. Pre-fix the table printed two `1`s — useless
    // for `cvault switch <N>`. Post-fix: rank by response index (the
    // server already orders FCFS by `_creationTime` ASC).
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce([
          meta({ slot: 1, email: 'saad@example.com', _creationTime: 1_700_000_000_000 }),
          meta({ slot: 1, email: 'samuel@example.com', _creationTime: 1_700_000_001_000 }),
        ]),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()

    const out = captured.join('\n')
    const lines = out.split('\n')
    // Header MUST use `#` (rank), not `SLOT` — the column shows position
    // in the FCFS list, which is what `cvault switch <N>` accepts.
    const headerLine = lines[0] ?? ''
    expect(headerLine).toMatch(/(?:^|\s)#(?:\s|$)/)
    expect(headerLine).not.toMatch(/SLOT/)

    const saadLine = lines.find((l) => l.includes('saad@example.com'))
    const samuelLine = lines.find((l) => l.includes('samuel@example.com'))
    expect(saadLine).toBeDefined()
    expect(samuelLine).toBeDefined()
    // First row: rank 1. Second row: rank 2.
    expect(saadLine).toMatch(/(?:^|\s)1(?:\s|$)/)
    expect(samuelLine).toMatch(/(?:^|\s)2(?:\s|$)/)
    // Critically: the second row must NOT render `1` (the stored slot).
    // This catches the pre-fix bug where two rows both showed `1`.
    const samuelCells = (samuelLine ?? '').trim().split(/\s{2,}/)
    expect(samuelCells[0]).not.toBe('* 1')
    expect(samuelCells[0]).not.toBe('  1')
  })

  it('R2: matches active marker case-insensitively (vault has Stefan@x.com, oauthAccount has stefan@x.com)', async () => {
    // Anthropic SMTP is case-insensitive; Clerk normalizes inconsistently.
    // The active marker must follow case-insensitive equality so the user
    // doesn't see "no active" for a sub they're actively using.
    const client = {
      query: vi.fn().mockResolvedValueOnce([meta({ slot: 1, email: 'Stefan@example.com' })]),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'stefan@example.com' })

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()
    const lines = captured.join('\n').split('\n')
    const sLine = lines.find((l) => l.includes('Stefan@example.com'))
    expect(sLine).toBeDefined()
    // Active marker present.
    expect(sLine).toMatch(/\*/)
  })
})
