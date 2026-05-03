/**
 * ExpiryCountdown — shows when a sub's access token expires.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8 (sub list cards
 * include expiry).
 *
 * Contract under test:
 * - Renders a label + relative time when expiresAt is in the future
 * - Renders "expired" when expiresAt is in the past
 * - Visually marks itself as `data-state="warning"` when within 5 minutes
 *   of expiry (matches the proactive-refresh window in actions.ts)
 * - Visually marks itself as `data-state="expired"` when past expiry
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ExpiryCountdown } from '../ExpiryCountdown'

describe('ExpiryCountdown', () => {
  it('renders a future expiry as a relative countdown', () => {
    const inOneHour = Date.now() + 60 * 60 * 1000
    render(<ExpiryCountdown expiresAt={inOneHour} />)
    expect(screen.getByText(/expires in/i)).toBeTruthy()
    // 60 minutes => "1h 0m" per the same formatCountdown helper used by UsageBar
    expect(screen.getByText(/1h 0m|59m/)).toBeTruthy()
  })

  it('renders "expired" when expiresAt is in the past', () => {
    const past = Date.now() - 60_000
    render(<ExpiryCountdown expiresAt={past} />)
    expect(screen.getByText(/expired/i)).toBeTruthy()
  })

  it('marks the component as warning when within 5 minutes of expiry', () => {
    const inFourMinutes = Date.now() + 4 * 60_000
    const { container } = render(<ExpiryCountdown expiresAt={inFourMinutes} />)
    const root = container.querySelector('[data-slot="expiry-countdown"]')
    expect(root?.getAttribute('data-state')).toBe('warning')
  })

  it('marks the component as expired when past expiry', () => {
    const past = Date.now() - 10_000
    const { container } = render(<ExpiryCountdown expiresAt={past} />)
    const root = container.querySelector('[data-slot="expiry-countdown"]')
    expect(root?.getAttribute('data-state')).toBe('expired')
  })

  it('marks the component as ok when more than 5 minutes from expiry', () => {
    const inOneHour = Date.now() + 60 * 60 * 1000
    const { container } = render(<ExpiryCountdown expiresAt={inOneHour} />)
    const root = container.querySelector('[data-slot="expiry-countdown"]')
    expect(root?.getAttribute('data-state')).toBe('ok')
  })
})
