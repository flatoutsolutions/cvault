/**
 * /dashboard (index) — sub list page tests.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §11 (testing).
 *
 * Mocks the Convex hooks `useQuery`/`useMutation` directly, so we cover
 * the page's own logic (loading state, empty state, render-each, action
 * wiring) without standing up a Convex provider.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SubsPage } from '../../routes/dashboard/index'

const useQueryMock = vi.fn()
const mutationsByName = new Map<string, ReturnType<typeof vi.fn>>()
const actionsByName = new Map<string, ReturnType<typeof vi.fn>>()

function getMutationMock(name: string) {
  let mock = mutationsByName.get(name)
  if (!mock) {
    mock = vi.fn().mockResolvedValue(null)
    mutationsByName.set(name, mock)
  }
  return mock
}

function getActionMock(name: string) {
  let mock = actionsByName.get(name)
  if (!mock) {
    mock = vi.fn().mockResolvedValue(null)
    actionsByName.set(name, mock)
  }
  return mock
}

function refToName(ref: unknown): string {
  // Convex `api.x.y.z` references are Proxies. Reading the
  // `Symbol.for('functionName')` symbol returns "x/y:z" for non-default
  // exports. We do the same here without a dependency on convex internals
  // by trying explicit fields first, then falling back to the symbol.
  const r = ref as Record<string | symbol, unknown>
  if (typeof r._functionPath === 'string') return r._functionPath
  if (typeof r._name === 'string') return r._name
  const sym = Symbol.for('functionName')
  const v = r[sym]
  return typeof v === 'string' ? v : 'default'
}

vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useMutation: (ref: unknown) => getMutationMock(refToName(ref)),
  useAction: (ref: unknown) => getActionMock(refToName(ref)),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
}))

function makeSub(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    _id: 'sub_1',
    _creationTime: now - 60_000,
    userId: 'user_1',
    email: 'alice@example.com',
    slot: 1,
    label: undefined,
    expiresAt: now + 60 * 60 * 1000,
    refreshExpiresAt: undefined,
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

describe('/dashboard sub list', () => {
  beforeEach(() => {
    useQueryMock.mockReset()
    for (const m of mutationsByName.values()) m.mockClear()
    for (const m of actionsByName.values()) m.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders skeletons while the query is loading (undefined)', () => {
    useQueryMock.mockReturnValue(undefined)
    const { container } = render(<SubsPage />)
    // Skeleton component renders divs with data-slot="skeleton".
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('renders the empty state when there are zero subs', () => {
    useQueryMock.mockReturnValue([])
    render(<SubsPage />)
    expect(screen.getByText(/no subscriptions yet/i)).toBeTruthy()
  })

  it('renders one card per sub', () => {
    useQueryMock.mockReturnValue([
      makeSub({ email: 'a@x.com', slot: 1 }),
      makeSub({ _id: 'sub_2', email: 'b@x.com', slot: 2 }),
    ])
    const { container } = render(<SubsPage />)
    expect(container.querySelectorAll('[data-slot="subscription-card"]').length).toBe(2)
    expect(screen.getByText('a@x.com')).toBeTruthy()
    expect(screen.getByText('b@x.com')).toBeTruthy()
  })

  it('calls softRemove when the Remove button is clicked', async () => {
    useQueryMock.mockReturnValue([makeSub({ email: 'alice@example.com' })])
    render(<SubsPage />)

    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    // Both rename and softRemove are tracked in mutationsByName. We
    // can't predict the keys (depend on Convex internals), so assert
    // that *some* mock got the expected payload.
    await waitFor(() => {
      const calls = Array.from(mutationsByName.values()).flatMap((m) => m.mock.calls)
      expect(
        calls.some((args) => args[0] !== undefined && (args[0] as { email?: string }).email === 'alice@example.com')
      ).toBe(true)
    })
  })

  it('renders the active count in the header', () => {
    useQueryMock.mockReturnValue([
      makeSub({ email: 'a@x.com' }),
      makeSub({ _id: 'sub_2', email: 'b@x.com', slot: 2 }),
      makeSub({ _id: 'sub_3', email: 'c@x.com', slot: 3 }),
    ])
    render(<SubsPage />)
    expect(screen.getByText(/3 active subscriptions/i)).toBeTruthy()
  })

  it('dispatches api.subscriptions.actions.requestRefresh when Force Refresh is clicked', async () => {
    const sub = makeSub({ _id: 'sub_target', email: 'alice@example.com' })
    useQueryMock.mockReturnValue([sub])
    render(<SubsPage />)

    fireEvent.click(screen.getByRole('button', { name: /force refresh/i }))

    await waitFor(() => {
      const calls = Array.from(actionsByName.values()).flatMap((m) => m.mock.calls)
      expect(
        calls.some((args) => args[0] !== undefined && (args[0] as { subId?: string }).subId === 'sub_target')
      ).toBe(true)
    })

    // The request must NOT be a console-only no-op: the action mock
    // must have actually been invoked. Sanity-check that at least one
    // action mock recorded a call.
    const totalActionCalls = Array.from(actionsByName.values()).reduce((sum, m) => sum + m.mock.calls.length, 0)
    expect(totalActionCalls).toBeGreaterThan(0)
  })
})
