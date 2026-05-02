/**
 * Scenario #9 — Dashboard "Force Refresh" button.
 *
 * Plan: docs/research/scenario-tests-plan.md §4.9.
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8 (Force Refresh
 *       per-card action) and §10 (manual refresh is the user's escape hatch
 *       when the cron is slow).
 *
 * Why a dedicated scenario: existing route-level tests
 * (frontend/src/__tests__/routes/dashboard.test.tsx) only assert the
 * Force Refresh button exists and is wired to a callback prop. They do NOT
 * assert the Convex action is dispatched. The two reviewers
 * (docs/reviews/superpowers-reviewer-2026-05-02.md §C2 and
 * docs/reviews/local-reviewer-2026-05-02.md §H2) explicitly flagged that
 * a green test suite was hiding a fake 250 ms console.warn placeholder in
 * `frontend/src/routes/dashboard/index.tsx:60-77`.
 *
 * THIS scenario asserts the actual wire: click → useAction(requestRefresh)
 * dispatches with `{ subId }`. It will FAIL until fix-builder lands the
 * fix that swaps the placeholder for the real action call (see
 * IMPLEMENTATION_NOTES.md, frontend agent's earlier requests #3, and the
 * H2 fix in local-reviewer-2026-05-02.md). FIX-PENDING markers below
 * highlight assertions that depend on the fix.
 *
 * Important name deviation: the user task brief says
 * `api.subscriptions.actions.refreshOAuthTokenForUser`. The shipped backend
 * exposes `requestRefresh` instead — see IMPLEMENTATION_NOTES.md "Frontend
 * agent's earlier requests #3". Asserting against the shipped name.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line import/first
import { SubsPage } from '../../src/routes/dashboard/index'

const useQueryMock = vi.fn()
const requestRefreshMock = vi.fn()
const renameMock = vi.fn().mockResolvedValue(null)
const softRemoveMock = vi.fn().mockResolvedValue(null)

// Track the action ref the component passes to useAction so we can verify
// the route is wired against the correct API surface.
const actionRefsSeen: Array<{ name: string }> = []

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
  useAction: (ref: unknown) => {
    const name = safeFunctionName(ref)
    actionRefsSeen.push({ name })
    return requestRefreshMock
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
}))

function makeSub(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    _id: 'sub_force_refresh' as unknown as string,
    _creationTime: now - 60_000,
    userId: 'user_1' as unknown as string,
    email: 'alice@example.com',
    slot: 1,
    label: undefined,
    // Near-expiry to model the realistic "user clicks force refresh" flow.
    expiresAt: now + 5 * 60 * 1000,
    refreshExpiresAt: now + 6 * 30 * 24 * 60 * 60 * 1000,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
    lastRefreshedAt: now - 30 * 60_000,
    refreshLeaseHolder: undefined,
    refreshLeaseUntil: undefined,
    usage5h: { pct: 42, resetsAt: now + 60 * 60 * 1000, fetchedAt: now },
    usage7d: { pct: 71, resetsAt: now + 6 * 24 * 60 * 60 * 1000, fetchedAt: now },
    removedAt: undefined,
    ...overrides,
  }
}

describe('scenario / force refresh button', () => {
  beforeEach(() => {
    useQueryMock.mockReset()
    requestRefreshMock.mockReset()
    requestRefreshMock.mockResolvedValue(null)
    renameMock.mockClear()
    softRemoveMock.mockClear()
    actionRefsSeen.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // FIX-PENDING (C2 / H2): the route currently calls a 250 ms
  // setTimeout in `handleForceRefresh` and never invokes useAction. Once
  // fix-builder lands the swap, this assertion will pass.
  it('dispatches api.subscriptions.actions.requestRefresh with the sub id when clicked', async () => {
    useQueryMock.mockReturnValue([makeSub({ _id: 'sub_force_refresh' })])

    render(<SubsPage />)

    fireEvent.click(screen.getByRole('button', { name: /force refresh/i }))

    await waitFor(() => {
      // The action is invoked with `{ subId }` per the backend's
      // requestRefresh signature (convex/subscriptions/actions.ts:156).
      expect(requestRefreshMock).toHaveBeenCalledTimes(1)
    })

    const callArgs = requestRefreshMock.mock.calls[0]?.[0]
    expect(callArgs).toBeDefined()
    expect(callArgs).toMatchObject({ subId: 'sub_force_refresh' })
  })

  // FIX-PENDING: depends on the dispatch landing first. Asserts the route
  // points useAction at the correct ref (api.subscriptions.actions.requestRefresh).
  it('passes the api.subscriptions.actions.requestRefresh action reference to useAction', () => {
    useQueryMock.mockReturnValue([makeSub()])
    render(<SubsPage />)

    // Whatever the route's useAction callsite is wired against, its ref
    // must include the `requestRefresh` symbol. This catches a future
    // rename to e.g. `refreshOAuthToken` from regressing the wire.
    expect(actionRefsSeen.some((r) => r.name.includes('requestRefresh'))).toBe(true)
  })

  // FIX-PENDING: the loading state today is governed by an artificial
  // setTimeout (250 ms). Once fix-builder lands the real action call, the
  // disabled state should mirror the action's pending state — i.e. button
  // is disabled WHILE the action is in-flight, re-enabled after.
  it('disables the Force Refresh button while the action is in-flight', async () => {
    useQueryMock.mockReturnValue([makeSub()])

    // Hold the action open so we can observe the in-flight state.
    let resolveAction: (() => void) | undefined
    requestRefreshMock.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveAction = () => resolve(null)
        })
    )

    render(<SubsPage />)

    const btn = screen.getByRole('button', { name: /force refresh/i })
    expect(btn.hasAttribute('disabled')).toBe(false)

    fireEvent.click(btn)

    // Disabled WHILE in-flight.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /refreshing/i }).hasAttribute('disabled')).toBe(true)
    })

    // Resolve the action; button should re-enable on next tick.
    resolveAction?.()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /force refresh/i }).hasAttribute('disabled')).toBe(false)
    })
  })

  // FIX-PENDING: the route currently swallows errors silently. Per the plan
  // §4.9 ("error → toast") and the H2 fix in local-reviewer §H2, a failed
  // refresh should be surfaced visibly. We don't pin a specific toast
  // implementation — we assert that *some* visible error indicator
  // appears (matching either a "failed"/"error" text node or a role=alert
  // node). Adjust the selector once the fix lands.
  it('surfaces a visible error when the refresh action throws', async () => {
    useQueryMock.mockReturnValue([makeSub()])
    requestRefreshMock.mockRejectedValueOnce(new Error('REFRESH_FAILED: Anthropic 500'))

    render(<SubsPage />)
    fireEvent.click(screen.getByRole('button', { name: /force refresh/i }))

    // The action threw; the user must see *something*. Accept any of:
    // - text containing "failed" or the error message body
    // - a role=alert node
    // - the disabled spinner clearing back without the user being told
    //   anything counts as a regression and we fail this assertion.
    await waitFor(
      () => {
        const visible =
          screen.queryByText(/refresh.*failed|REFRESH_FAILED|Anthropic 500/i) ?? screen.queryByRole('alert')
        expect(visible).not.toBeNull()
      },
      { timeout: 1500 }
    )
  })

  it('passes the correct sub id when there are multiple subs and only one is clicked', async () => {
    useQueryMock.mockReturnValue([
      makeSub({ _id: 'sub_alice', email: 'alice@example.com' }),
      makeSub({ _id: 'sub_bob', email: 'bob@example.com', slot: 2 }),
    ])

    render(<SubsPage />)

    // Click the second card's Force Refresh button.
    const buttons = screen.getAllByRole('button', { name: /force refresh/i })
    expect(buttons).toHaveLength(2)
    if (!buttons[1]) throw new Error('expected at least 2 force-refresh buttons')
    fireEvent.click(buttons[1])

    await waitFor(() => {
      expect(requestRefreshMock).toHaveBeenCalledTimes(1)
    })
    expect(requestRefreshMock.mock.calls[0]?.[0]).toMatchObject({ subId: 'sub_bob' })
  })
})
