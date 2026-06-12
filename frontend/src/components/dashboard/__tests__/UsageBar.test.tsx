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

import { UsageBar } from '../UsageBar'

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

  it('shows "Ready" for an idle 5h window when idlePresentation="ready"', () => {
    const { container } = render(
      <UsageBar label="5h" usage={{ idle: true, fetchedAt: Date.now() }} idlePresentation="ready" />
    )
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByText(/fresh window starts on next use/i)).toBeTruthy()
    // Distinct data-state so styling stays co-located and tests don't depend on classes.
    const root = container.querySelector('[data-slot="usage-bar"]')
    expect(root?.getAttribute('data-state')).toBe('ready')
  })

  it('renders an idle window as "—" when idlePresentation is "none" (e.g. 7d)', () => {
    render(<UsageBar label="7d" usage={{ idle: true, fetchedAt: Date.now() }} />)
    expect(screen.getByText('—')).toBeTruthy()
    // Must NOT claim "Ready" for 7d — an absent weekly window is ambiguous.
    expect(screen.queryByText('Ready')).toBeNull()
  })

  it('degrades an idle 5h window to stale when the data is old', () => {
    const now = Date.now()
    const fetchedAt = now - 20 * 60 * 1000 // 20m old, past the 15m threshold
    const { container } = render(
      <UsageBar label="5h" usage={{ idle: true, fetchedAt }} idlePresentation="ready" now={now} />
    )
    const root = container.querySelector('[data-slot="usage-bar"]')
    // No longer the confident affordance — flagged stale with a last-checked hint.
    expect(root?.getAttribute('data-state')).toBe('stale')
    expect(screen.getByText(/last checked/i)).toBeTruthy()
    expect(screen.queryByText(/fresh window starts on next use/i)).toBeNull()
  })

  it('does not claim "Ready" for a relogin-required (dead-token) sub', () => {
    const now = Date.now()
    render(
      <UsageBar
        label="5h"
        usage={{ idle: true, fetchedAt: now }}
        idlePresentation="ready"
        now={now}
        tokenAlive={false}
      />
    )
    // A dead token is not usable regardless of the last polled window.
    expect(screen.queryByText('Ready')).toBeNull()
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('marks an active window stale but still shows the percentage', () => {
    const now = Date.now()
    const usage = { pct: 40, resetsAt: now + 60 * 60 * 1000, fetchedAt: now - 20 * 60 * 1000 }
    const { container } = render(<UsageBar label="5h" usage={usage} now={now} />)
    const root = container.querySelector('[data-slot="usage-bar"]')
    expect(root?.getAttribute('data-state')).toBe('stale')
    expect(screen.getByText('40%')).toBeTruthy()
    expect(screen.getByText(/checked/i)).toBeTruthy()
  })

  it('uses the injected now for the countdown so it ticks without a reload', () => {
    const now = Date.now()
    const usage = { pct: 50, resetsAt: now + 2 * 60 * 60 * 1000, fetchedAt: now }
    const { rerender } = render(<UsageBar label="5h" usage={usage} now={now} />)
    expect(screen.getByText(/2h 0m/)).toBeTruthy()
    // One hour later, same data → the countdown shrinks (no new Convex push needed).
    rerender(<UsageBar label="5h" usage={usage} now={now + 60 * 60 * 1000} />)
    expect(screen.getByText(/1h 0m/)).toBeTruthy()
  })
})
