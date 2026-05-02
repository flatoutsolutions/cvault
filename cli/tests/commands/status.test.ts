/**
 * Spec: §7 — `cvault status`.
 *
 * Combines `claude-swap --status` (local active sub) with
 * `api.subscriptions.queries.getMetaByEmail` (server-side meta for that
 * sub: usage, expiry, last refresh).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/claudeSwap', () => ({
  status: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

import { status } from '../../src/claudeSwap'
import { runStatus } from '../../src/commands/status'
import { makeVaultClient } from '../../src/convex/vaultClient'

describe('runStatus', () => {
  // Each test queues `vi.mocked(makeVaultClient).mockResolvedValueOnce(...)`.
  // Without a reset, an unconsumed once-mock from one test bleeds into the
  // next call sequence. Clearing mocks per test keeps them independent.
  beforeEach(() => {
    vi.mocked(makeVaultClient).mockReset()
    vi.mocked(status).mockReset()
  })

  it('renders active local sub plus the matching Convex meta', async () => {
    vi.mocked(status).mockReturnValueOnce('Active account: 1 (a@b.com)\n')
    const client = {
      query: vi.fn().mockResolvedValueOnce({
        email: 'a@b.com',
        slot: 1,
        expiresAt: Date.now() + 60_000,
        lastRefreshedAt: Date.now() - 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        usage5h: { pct: 12, resetsAt: 0, fetchedAt: 0 },
        usage7d: { pct: 34, resetsAt: 0, fetchedAt: 0 },
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runStatus()
    const out = captured.join('\n')
    expect(out).toContain('a@b.com')
    expect(out).toContain('1') // slot
    expect(out).toMatch(/12%/)
    expect(out).toMatch(/34%/)
  })

  it('handles "no active account" gracefully', async () => {
    vi.mocked(status).mockReturnValueOnce('No active account')
    const client = { query: vi.fn() }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runStatus()
    expect(captured.join('\n')).toMatch(/no active/i)
    expect(client.query).not.toHaveBeenCalled()
  })

  it('renders local-only when Convex returns null for the active email', async () => {
    vi.mocked(status).mockReturnValueOnce('Active account: 1 (orphan@x.com)\n')
    const client = { query: vi.fn().mockResolvedValueOnce(null) }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runStatus()
    const out = captured.join('\n')
    expect(out).toContain('orphan@x.com')
    expect(out).toMatch(/not in the vault/i)
  })

  // Pinning the real `claude-swap --status` shape (verified against the
  // installed binary on 2026-05-02). The trailing `[org]` annotation must
  // NOT be swallowed by the email capture.
  it('parses real `Status: Account-N (email [org])` output', async () => {
    vi.mocked(status).mockReturnValueOnce(
      'Status: Account-2 (samuel.asseg@gmail.com [Acme Inc])\n  Total managed accounts: 2\n'
    )
    const client = {
      query: vi.fn().mockResolvedValueOnce({
        email: 'samuel.asseg@gmail.com',
        slot: 2,
        expiresAt: Date.now() + 60_000,
        lastRefreshedAt: Date.now(),
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        usage5h: null,
        usage7d: null,
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runStatus()
    expect(client.query).toHaveBeenCalledWith(
      expect.anything(),
      { email: 'samuel.asseg@gmail.com' }
    )
    expect(captured.join('\n')).toContain('samuel.asseg@gmail.com')
  })
})
