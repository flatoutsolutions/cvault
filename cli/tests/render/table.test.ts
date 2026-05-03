/**
 * Spec: §7 — `cvault list` table renderer.
 *
 * Renders subscription rows with columns: slot, email, label, 5h%, 7d%,
 * expires-in (relative), last refresh (relative), active marker.
 */
import { describe, expect, it } from 'vitest'

import { type SubRow, formatRelativeMs, renderSubsTable } from '../../src/render/table'

const NOW = 1_700_000_000_000

function row(overrides: Partial<SubRow> = {}): SubRow {
  return {
    slot: 1,
    email: 'a@b.com',
    label: 'work',
    expiresAt: NOW + 60 * 60 * 1000,
    lastRefreshedAt: NOW - 5 * 60 * 1000,
    usage5hPct: 23,
    usage7dPct: 41,
    isActive: false,
    ...overrides,
  }
}

describe('formatRelativeMs', () => {
  it('formats positive durations as "in Xs/m/h/d"', () => {
    expect(formatRelativeMs(NOW + 30_000, NOW)).toBe('in 30s')
    expect(formatRelativeMs(NOW + 5 * 60_000, NOW)).toBe('in 5m')
    expect(formatRelativeMs(NOW + 2 * 60 * 60_000, NOW)).toBe('in 2h')
    expect(formatRelativeMs(NOW + 3 * 24 * 60 * 60_000, NOW)).toBe('in 3d')
  })

  it('formats past durations as "Xs/m/h/d ago"', () => {
    expect(formatRelativeMs(NOW - 30_000, NOW)).toBe('30s ago')
    expect(formatRelativeMs(NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(formatRelativeMs(NOW - 2 * 60 * 60_000, NOW)).toBe('2h ago')
  })

  it('returns "now" for zero diff', () => {
    expect(formatRelativeMs(NOW, NOW)).toBe('now')
  })
})

describe('renderSubsTable', () => {
  it('renders a header row + each sub row with stable columns', () => {
    const out = renderSubsTable([row({ slot: 1, email: 'alice@x.com', isActive: true })], NOW)
    expect(out).toContain('SLOT')
    expect(out).toContain('EMAIL')
    expect(out).toContain('LABEL')
    expect(out).toContain('5H')
    expect(out).toContain('7D')
    expect(out).toContain('EXPIRES')
    expect(out).toContain('LAST REFRESH')
    expect(out).toContain('STORED')
    expect(out).toContain('alice@x.com')
  })

  it('marks STORED as `local+cloud` for the active sub and `cloud` for vault-only subs', () => {
    const out = renderSubsTable(
      [row({ slot: 1, email: 'a@b.com', isActive: true }), row({ slot: 2, email: 'c@d.com', isActive: false })],
      NOW
    )
    const lines = out.split('\n')
    const aLine = lines.find((l) => l.includes('a@b.com'))
    const cLine = lines.find((l) => l.includes('c@d.com'))
    expect(aLine).toContain('local+cloud')
    // Vault-only row must NOT incidentally match "cloud" via "local+cloud".
    expect(cLine).toContain('cloud')
    expect(cLine).not.toContain('local')
  })

  it('marks the active sub with a dot prefix', () => {
    const out = renderSubsTable(
      [row({ slot: 1, email: 'a@b.com', isActive: false }), row({ slot: 2, email: 'c@d.com', isActive: true })],
      NOW
    )
    const lines = out.split('\n')
    const aLine = lines.find((l) => l.includes('a@b.com'))
    const cLine = lines.find((l) => l.includes('c@d.com'))
    expect(aLine).not.toMatch(/^\s*\*/)
    expect(cLine).toMatch(/\*/) // some marker
  })

  it('renders missing usage as "-"', () => {
    const out = renderSubsTable([row({ usage5hPct: undefined, usage7dPct: undefined })], NOW)
    expect(out).toMatch(/\s-\s/)
  })

  it('rounds usage percentages to integers', () => {
    const out = renderSubsTable([row({ usage5hPct: 23.7, usage7dPct: 41.4 })], NOW)
    expect(out).toContain('24%')
    expect(out).toContain('41%')
  })

  it('flags relogin when refreshExpiresAt is in the past', () => {
    const out = renderSubsTable([row({ refreshExpiresAt: NOW - 60_000 })], NOW)
    expect(out).toMatch(/relogin/i)
  })

  it('returns a friendly empty state when there are no subs', () => {
    const out = renderSubsTable([], NOW)
    expect(out).toMatch(/no subscriptions/i)
  })
})
