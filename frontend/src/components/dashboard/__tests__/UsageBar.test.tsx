/**
 * UsageBar — renders a usage window (5h or 7d) as a labeled progress bar.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8 (sub list cards
 * w/ usage bars).
 *
 * Contract under test:
 * - Renders the window label (e.g. "5h" or "7d")
 * - Renders the percentage as integer (rounded from the API's float)
 * - Renders the reset countdown derived from `resetsAt`
 * - Renders an "unknown" placeholder when the usage is null/undefined
 *   (e.g. Pro accounts don't have a 7d window; some subs haven't been
 *   polled yet)
 * - Sets a destructive visual variant when pct >= 90 (so the user notices
 *   when an account is about to hit the limit)
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { UsageBar, formatRelativeAgo } from '../UsageBar'

describe('UsageBar', () => {
  it('renders the window label and integer percentage', () => {
    const oneHourFromNow = Date.now() + 60 * 60 * 1000
    render(<UsageBar label="5h" usage={{ pct: 42.7, resetsAt: oneHourFromNow, fetchedAt: Date.now() }} />)
    // Label is shown verbatim
    expect(screen.getByText('5h')).toBeTruthy()
    // Percentage is rounded to nearest integer (43 not 42.7)
    expect(screen.getByText('43%')).toBeTruthy()
  })

  it('renders an "unknown" placeholder when usage is undefined', () => {
    render(<UsageBar label="7d" usage={undefined} />)
    // The label still appears
    expect(screen.getByText('7d')).toBeTruthy()
    // And a placeholder for the missing percentage
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('marks the bar as critical when pct >= 90', () => {
    const future = Date.now() + 60_000
    const { container } = render(<UsageBar label="5h" usage={{ pct: 95, resetsAt: future, fetchedAt: Date.now() }} />)
    // Critical state is signalled via data-state so styling stays
    // co-located in the component but tests don't depend on Tailwind classes.
    const root = container.querySelector('[data-slot="usage-bar"]')
    expect(root).not.toBeNull()
    expect(root?.getAttribute('data-state')).toBe('critical')
  })

  it('uses a normal data-state when pct < 90', () => {
    const future = Date.now() + 60_000
    const { container } = render(<UsageBar label="5h" usage={{ pct: 30, resetsAt: future, fetchedAt: Date.now() }} />)
    const root = container.querySelector('[data-slot="usage-bar"]')
    expect(root?.getAttribute('data-state')).toBe('normal')
  })

  it('renders a human countdown to resetsAt', () => {
    // 3 hours and 15 minutes in the future
    const resetsAt = Date.now() + 3 * 60 * 60 * 1000 + 15 * 60 * 1000
    render(<UsageBar label="5h" usage={{ pct: 50, resetsAt, fetchedAt: Date.now() }} />)
    // Countdown format: "Xh Xm" for less than a day, "Xd Xh" for more.
    // Allow a fuzzy match (3h 14m vs 3h 15m) since rendering takes a tick.
    const countdownEl = screen.getByText(/3h 1[45]m/)
    expect(countdownEl).toBeTruthy()
  })

  it('shows "now" when resetsAt is in the past', () => {
    const past = Date.now() - 60_000
    render(<UsageBar label="5h" usage={{ pct: 50, resetsAt: past, fetchedAt: Date.now() }} />)
    expect(screen.getByText(/now|0m/i)).toBeTruthy()
  })
})

describe('formatRelativeAgo', () => {
  const NOW = 1_700_000_000_000

  it('returns "just now" for ages under one minute', () => {
    expect(formatRelativeAgo(NOW - 30_000, NOW)).toBe('just now')
  })

  it('emits compound h+m for ages between 1h and 1d', () => {
    // 125 minutes = 2h 5m. Pre-fix this rendered as "125m ago".
    expect(formatRelativeAgo(NOW - 125 * 60_000, NOW)).toBe('2h 5m ago')
  })

  it('emits plain minutes under 1h', () => {
    expect(formatRelativeAgo(NOW - 45 * 60_000, NOW)).toBe('45m ago')
  })

  it('emits compound d+h for ages over a day', () => {
    expect(formatRelativeAgo(NOW - (2 * 24 * 60 + 3 * 60) * 60_000, NOW)).toBe('2d 3h ago')
  })
})
