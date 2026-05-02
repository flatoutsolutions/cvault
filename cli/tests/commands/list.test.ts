/**
 * Spec: §7 — `cvault list`.
 *
 * Calls `api.subscriptions.queries.listForUser`, then `claude-swap --status`
 * to determine which sub is currently active locally, then renders a table.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/claudeSwap', () => ({
  status: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

import { status } from '../../src/claudeSwap'
import { runList } from '../../src/commands/list'
import { makeVaultClient } from '../../src/convex/vaultClient'

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
  usage5h?: { pct: number; resetsAt: number; fetchedAt: number } | undefined
  usage7d?: { pct: number; resetsAt: number; fetchedAt: number } | undefined
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
  it('renders all subs from Convex with the locally-active one marked', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([
        meta({ slot: 1, email: 'a@b.com' }),
        meta({ slot: 2, email: 'c@d.com' }),
      ]),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)
    vi.mocked(status).mockReturnValueOnce('Active account: 2 (c@d.com)')

    const captured: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()

    const out = captured.join('\n')
    expect(out).toContain('a@b.com')
    expect(out).toContain('c@d.com')
    // Active line for slot 2 should have the asterisk marker
    const lines = out.split('\n')
    const cLine = lines.find((l) => l.includes('c@d.com'))
    expect(cLine).toMatch(/\*/)
    logSpy.mockRestore()
  })

  it('renders empty-state when user has no subs', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce([]) }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)
    vi.mocked(status).mockReturnValueOnce('No active account')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await runList()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/no subscriptions/i)
    )
    logSpy.mockRestore()
  })

  it('handles missing usage data gracefully', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([
        meta({ usage5h: undefined, usage7d: undefined }),
      ]),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)
    vi.mocked(status).mockReturnValueOnce('Active account: 1 (a@b.com)')

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()
    expect(captured.join('\n')).toMatch(/\s-\s/)
  })

  it('does not crash if claude-swap --status fails (offline / not installed)', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([meta()]),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)
    vi.mocked(status).mockImplementationOnce(() => {
      throw new Error('claude-swap missing')
    })

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()
    // Output should still render — just without an active marker.
    expect(captured.join('\n')).toContain('a@b.com')
  })
})
