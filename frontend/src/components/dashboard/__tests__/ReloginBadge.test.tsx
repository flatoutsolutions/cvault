/**
 * ReloginBadge — visible warning that the refresh token itself is dead
 * and the user must re-add the account from the CLI.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §10 ("Anthropic
 * refresh 401 (refresh_token dead) → Patch refreshExpiresAt=now; log
 * `reloginRequired`; surface in `list` w/ ⚠ relogin flag").
 *
 * Heuristic: we treat `refreshExpiresAt <= now` as "relogin required".
 * The mark-relogin internal mutation clamps that field exactly when it
 * detects an `invalid_grant` from Anthropic (see
 * convex/subscriptions/mutations.ts:markReloginRequired).
 *
 * Contract under test:
 * - Renders nothing when refreshExpiresAt is absent or far in the future
 * - Renders a visible "Relogin required" badge when refreshExpiresAt <= now
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ReloginBadge } from '../ReloginBadge'

describe('ReloginBadge', () => {
  it('renders nothing when refreshExpiresAt is undefined', () => {
    const { container } = render(<ReloginBadge refreshExpiresAt={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when refreshExpiresAt is in the future', () => {
    const future = Date.now() + 30 * 24 * 60 * 60 * 1000
    const { container } = render(<ReloginBadge refreshExpiresAt={future} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a relogin badge when refreshExpiresAt is in the past', () => {
    const past = Date.now() - 1000
    render(<ReloginBadge refreshExpiresAt={past} />)
    expect(screen.getByText(/relogin required/i)).toBeTruthy()
  })

  it('renders a relogin badge when refreshExpiresAt is exactly now', () => {
    // The mark-relogin mutation sets `refreshExpiresAt: Date.now()` which
    // means the badge should fire on the same tick.
    const now = Date.now()
    render(<ReloginBadge refreshExpiresAt={now} />)
    expect(screen.getByText(/relogin required/i)).toBeTruthy()
  })
})
