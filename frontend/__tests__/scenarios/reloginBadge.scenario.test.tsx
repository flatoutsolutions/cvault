/**
 * Scenario #8b — Refresh dead, dashboard renders relogin badge.
 *
 * Plan: docs/research/scenario-tests-plan.md §4.8 (frontend half).
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §10
 *       (refresh failure → markReloginRequired clamps refreshExpiresAt = now)
 *       §8 (dashboard surfaces a warning so the user knows to re-add).
 *
 * Backend half (`convex/__scenarios__/refreshReloginRequired.scenario.test.ts`)
 * proves that a 401 invalid_grant from Anthropic clamps `refreshExpiresAt`
 * to `now`. THIS half proves the dashboard then surfaces the badge so the
 * user has a visible signal that they must run `cvault add` again.
 *
 * The Convex hooks (`useQuery`, `useMutation`) are mocked at the module
 * boundary so we can drive the page entirely from test data — same shape
 * the existing route-level tests use (see
 * frontend/src/__tests__/routes/dashboard.test.tsx).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SubsPage } from '../../src/routes/dashboard/index'

const useQueryMock = vi.fn()
const renameMock = vi.fn().mockResolvedValue(null)
const softRemoveMock = vi.fn().mockResolvedValue(null)
const requestRefreshMock = vi.fn().mockResolvedValue(null)

/**
 * Convex `FunctionReference` is a Proxy whose internal name is exposed by
 * `getFunctionName()`. The legacy `_name`/`_functionPath` properties are
 * not reliably present (and are removed in newer Convex versions). Always
 * route through `getFunctionName()`.
 */
function safeFunctionName(ref: unknown): string {
  try {
    return getFunctionName(ref as Parameters<typeof getFunctionName>[0])
  } catch {
    return ''
  }
}

vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useMutation: (ref: unknown) => {
    const name = safeFunctionName(ref)
    if (name.includes('softRemove')) return softRemoveMock
    return renameMock
  },
  useAction: () => requestRefreshMock,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
}))

// Use Date.now() at fixture-creation time so the test is robust to small
// clock skew in CI.
function makeReloginRequiredSub(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    _id: 'sub_relogin' as unknown as string,
    _creationTime: now - 60_000,
    userId: 'user_1' as unknown as string,
    email: 'alice@example.com',
    slot: 1,
    label: undefined,
    expiresAt: now + 60 * 60 * 1000,
    // The signal: refresh token is dead; clamped to "now-ish".
    refreshExpiresAt: now - 1_000,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
    lastRefreshedAt: now - 10 * 60_000,
    refreshLeaseHolder: undefined,
    refreshLeaseUntil: undefined,
    usage5h: { pct: 0, resetsAt: now + 60 * 60 * 1000, fetchedAt: now },
    usage7d: { pct: 0, resetsAt: now + 6 * 24 * 60 * 60 * 1000, fetchedAt: now },
    removedAt: undefined,
    ...overrides,
  }
}

describe('scenario / relogin badge', () => {
  beforeEach(() => {
    useQueryMock.mockReset()
    renameMock.mockClear()
    softRemoveMock.mockClear()
    requestRefreshMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the relogin badge for a sub whose refreshExpiresAt is in the past', () => {
    useQueryMock.mockReturnValue([makeReloginRequiredSub()])

    render(<SubsPage />)

    // The ReloginBadge component renders the literal "Relogin required" text
    // (frontend/src/components/dashboard/ReloginBadge.tsx). This is the
    // user-visible signal that maps to spec §10's "refreshExpiresAt clamped".
    expect(screen.getByText(/relogin required/i)).toBeTruthy()
  })

  it('does NOT render the badge when refreshExpiresAt is in the future', () => {
    const now = Date.now()
    useQueryMock.mockReturnValue([makeReloginRequiredSub({ refreshExpiresAt: now + 7 * 24 * 60 * 60 * 1000 })])

    render(<SubsPage />)

    expect(screen.queryByText(/relogin required/i)).toBeNull()
  })

  it('does NOT render the badge when refreshExpiresAt is undefined (fresh sub)', () => {
    useQueryMock.mockReturnValue([makeReloginRequiredSub({ refreshExpiresAt: undefined })])

    render(<SubsPage />)

    expect(screen.queryByText(/relogin required/i)).toBeNull()
  })

  it('renders the badge alongside the email so the user can identify which sub is dead', () => {
    useQueryMock.mockReturnValue([
      makeReloginRequiredSub({ email: 'work@example.com' }),
      makeReloginRequiredSub({
        _id: 'sub_other' as unknown as string,
        email: 'personal@example.com',
        slot: 2,
        refreshExpiresAt: undefined,
      }),
    ])

    render(<SubsPage />)

    // Both subs render; only the first has the badge.
    expect(screen.getByText('work@example.com')).toBeTruthy()
    expect(screen.getByText('personal@example.com')).toBeTruthy()
    // Exactly one badge across both cards.
    const badges = screen.getAllByText(/relogin required/i)
    expect(badges).toHaveLength(1)
  })

  // FIX-PENDING: the system prompt brief for this scenario asks that
  // "click on the card surfaces re-login instructions". The shipped
  // `ReloginBadge` and `SubscriptionCard` do not yet render an inline
  // instructional message ("run `cvault add` to re-authorize") on click.
  // Once that UX lands, replace this with a real assertion (look for the
  // instruction text after a card click). Until then, the badge alone is
  // the signal.
  it.todo('clicking the relogin badge surfaces "run `cvault add` to re-authorize" instructions')

  // Sanity check: the underlying SubscriptionCard semantics weren't broken
  // by adding the badge — the email + slot still render normally.
  it('still renders the sub email, slot, and Force Refresh button when relogin required', () => {
    useQueryMock.mockReturnValue([makeReloginRequiredSub()])

    render(<SubsPage />)

    expect(screen.getByText('alice@example.com')).toBeTruthy()
    expect(screen.getByText(/slot 1/i)).toBeTruthy()
    // The Force Refresh button is present even for a relogin-required sub.
    // (Pressing it would fail server-side, but the UI doesn't pre-empt
    // that — the user sees the failure via a refreshLog row.)
    const forceRefreshBtn = screen.getByRole('button', { name: /force refresh/i })
    expect(forceRefreshBtn).toBeTruthy()
    // The badge and the action button coexist; assert the action button
    // is NOT mistakenly disabled by the relogin state.
    expect(forceRefreshBtn.hasAttribute('disabled')).toBe(false)

    // Defensive: simulate a click and assert nothing throws synchronously.
    // We don't assert the action call here — the dedicated forceRefresh
    // scenario covers that.
    expect(() => {
      fireEvent.click(forceRefreshBtn)
    }).not.toThrow()
  })
})
