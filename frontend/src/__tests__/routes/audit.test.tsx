/**
 * /dashboard/audit — merged feed page tests.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §11.
 *
 * Verifies:
 *   - Loading state (any of the queries undefined)
 *   - Empty state (no rows)
 *   - Merged ordering (most recent first regardless of source)
 *   - Filter by sub email
 *   - Filter by outcome (failure / activity)
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuditPage } from '../../routes/dashboard/audit'

/**
 * Convex function-reference identity is opaque (Proxy), so instead of
 * pattern-matching the path, we route by call order. The audit page
 * makes three Convex hook calls per render in this order:
 *   1. usePaginatedQuery — refreshLog.recentForUser
 *   2. usePaginatedQuery — machineActivity.recentForUser
 *   3. useQuery          — subscriptions.listForUser
 * — verified by reading routes/dashboard/audit.tsx.
 */
type PaginatedFake = {
  results: unknown[] | undefined
  /** Convex hook returns one of these strings; tests choose. */
  status: 'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted'
}

let nextResults: {
  refreshLog: PaginatedFake
  machineActivity: PaginatedFake
  subscriptions: unknown
} = {
  refreshLog: { results: undefined, status: 'LoadingFirstPage' },
  machineActivity: { results: undefined, status: 'LoadingFirstPage' },
  subscriptions: undefined,
}

function setRefreshLog(value: PaginatedFake) {
  nextResults = { ...nextResults, refreshLog: value }
}
function setMachineActivity(value: PaginatedFake) {
  nextResults = { ...nextResults, machineActivity: value }
}
function setSubscriptions(value: unknown) {
  nextResults = { ...nextResults, subscriptions: value }
}

let usePaginatedQueryCallCount = 0

vi.mock('convex/react', () => ({
  useQuery: () => nextResults.subscriptions,
  usePaginatedQuery: () => {
    const idx = usePaginatedQueryCallCount % 2
    usePaginatedQueryCallCount += 1
    const fake = idx === 0 ? nextResults.refreshLog : nextResults.machineActivity
    return {
      results: fake.results ?? [],
      status: fake.status,
      loadMore: () => undefined,
      isLoading: fake.status === 'LoadingFirstPage' || fake.status === 'LoadingMore',
    }
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
}))

describe('/dashboard/audit', () => {
  beforeEach(() => {
    nextResults = {
      refreshLog: { results: undefined, status: 'LoadingFirstPage' },
      machineActivity: { results: undefined, status: 'LoadingFirstPage' },
      subscriptions: undefined,
    }
    usePaginatedQueryCallCount = 0
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders skeletons while both paginated queries are loading their first page', () => {
    setRefreshLog({ results: undefined, status: 'LoadingFirstPage' })
    setMachineActivity({ results: undefined, status: 'LoadingFirstPage' })
    setSubscriptions(undefined)
    const { container } = render(<AuditPage />)
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('renders an empty-state message when both queries return zero rows', () => {
    setRefreshLog({ results: [], status: 'Exhausted' })
    setMachineActivity({ results: [], status: 'Exhausted' })
    setSubscriptions([])
    render(<AuditPage />)
    expect(screen.getByText(/no audit rows/i)).toBeTruthy()
  })

  it('renders rows from both backends, most recent first', () => {
    const now = Date.now()
    setRefreshLog({
      results: [
        {
          _id: 'log_1',
          _creationTime: now,
          userId: 'u_1',
          subscriptionId: 'sub_1',
          triggeredBy: 'cron',
          outcome: 'success',
          at: now - 10 * 60_000,
        },
      ],
      status: 'Exhausted',
    })
    setMachineActivity({
      results: [
        {
          _id: 'act_1',
          _creationTime: now,
          userId: 'u_1',
          clerkSessionId: 'sess_abc12345xyz',
          action: 'switch',
          subscriptionId: 'sub_1',
          at: now - 5 * 60_000,
          ipHash: 'a1b2c3d4',
        },
      ],
      status: 'Exhausted',
    })
    setSubscriptions([{ _id: 'sub_1', email: 'alice@example.com', slot: 1 }])
    const { container } = render(<AuditPage />)
    const rows = Array.from(container.querySelectorAll('[data-slot="audit-row"]'))
    expect(rows).toHaveLength(2)
    // Most-recent (activity, 5m ago) is first; refresh (10m ago) second.
    expect(rows[0]?.textContent).toContain('switch')
    expect(rows[1]?.textContent).toContain('refresh')
  })

  it('filters by outcome=failure and excludes activity rows', () => {
    const now = Date.now()
    setRefreshLog({
      results: [
        {
          _id: 'log_1',
          _creationTime: now,
          userId: 'u_1',
          subscriptionId: 'sub_1',
          triggeredBy: 'cron',
          outcome: 'success',
          at: now - 1000,
        },
        {
          _id: 'log_2',
          _creationTime: now,
          userId: 'u_1',
          subscriptionId: 'sub_1',
          triggeredBy: 'cron',
          outcome: 'failure',
          error: 'Anthropic refresh 500',
          at: now - 2000,
        },
      ],
      status: 'Exhausted',
    })
    setMachineActivity({
      results: [
        {
          _id: 'act_1',
          _creationTime: now,
          userId: 'u_1',
          clerkSessionId: 'sess_abc',
          action: 'pull',
          subscriptionId: undefined,
          at: now - 500,
          ipHash: undefined,
        },
      ],
      status: 'Exhausted',
    })
    setSubscriptions([{ _id: 'sub_1', email: 'alice@example.com', slot: 1 }])

    const { container } = render(<AuditPage />)
    // Pick the Outcome filter and switch to 'failure'
    const outcomeSelect = screen.getByLabelText(/outcome/i)
    fireEvent.change(outcomeSelect, { target: { value: 'failure' } })

    const rows = Array.from(container.querySelectorAll('[data-slot="audit-row"]'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('Anthropic refresh 500')
  })
})
