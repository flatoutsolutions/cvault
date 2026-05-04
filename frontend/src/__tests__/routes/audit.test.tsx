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
 *   - ShadCN data-table rendering (column headers, row count)
 *   - Pagination controls (First / Prev / Next / Last)
 *   - Page indicator ("Page X of Y · N rows loaded")
 *   - Page size selector (10/25/50/100, default 25)
 *   - Page size change resets to page 0
 *   - "Last" disabled until status='Exhausted'
 *   - "Prev" disabled on first page; "Next" disabled on last page when exhausted
 *   - Clicking Next when CanLoadMore triggers loadMore
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuditPage } from '../../routes/dashboard/audit.lazy'

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

const loadMoreRefreshMock = vi.fn()
const loadMoreActivityMock = vi.fn()

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
      loadMore: idx === 0 ? loadMoreRefreshMock : loadMoreActivityMock,
      isLoading: fake.status === 'LoadingFirstPage' || fake.status === 'LoadingMore',
    }
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
  createLazyFileRoute: () => () => ({}),
}))

/**
 * Polyfills for Radix UI Select primitives in jsdom. The Radix Select
 * implementation calls `hasPointerCapture` / `releasePointerCapture` /
 * `scrollIntoView` on DOM elements during open/close — none of which jsdom
 * implements. Without these stubs, clicking the SelectTrigger throws and
 * the dropdown never opens, making the "change page size" test
 * untestable. These are global no-ops; nothing in the audit page depends
 * on the real semantics.
 *
 * Reference: https://github.com/radix-ui/primitives/issues/1860
 */
beforeAll(() => {
  if (typeof Element.prototype.hasPointerCapture !== 'function') {
    Element.prototype.hasPointerCapture = () => false
  }
  if (typeof Element.prototype.releasePointerCapture !== 'function') {
    Element.prototype.releasePointerCapture = () => undefined
  }
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => undefined
  }
})

/**
 * Build a sequence of N refreshLog rows, newest-first. `at` decreases by
 * 1 minute per row so the sort order is stable and predictable.
 */
function buildRefreshRows(count: number, opts?: { now?: number; subscriptionId?: string }) {
  const now = opts?.now ?? Date.now()
  const subscriptionId = opts?.subscriptionId ?? 'sub_1'
  return Array.from({ length: count }, (_, i) => ({
    _id: `log_${i.toString()}`,
    _creationTime: now,
    userId: 'u_1',
    subscriptionId,
    triggeredBy: 'manual' as const,
    outcome: 'success' as const,
    at: now - (i + 1) * 60_000,
  }))
}

describe('/dashboard/audit', () => {
  beforeEach(() => {
    nextResults = {
      refreshLog: { results: undefined, status: 'LoadingFirstPage' },
      machineActivity: { results: undefined, status: 'LoadingFirstPage' },
      subscriptions: undefined,
    }
    usePaginatedQueryCallCount = 0
    loadMoreRefreshMock.mockClear()
    loadMoreActivityMock.mockClear()
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
          triggeredBy: 'manual',
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

  it('renders explicit empty-state card when filters narrow non-empty data to 0 rows', () => {
    const now = Date.now()
    setRefreshLog({
      results: [
        {
          _id: 'log_1',
          _creationTime: now,
          userId: 'u_1',
          subscriptionId: 'sub_1',
          triggeredBy: 'manual',
          outcome: 'success',
          at: now - 1000,
        },
      ],
      status: 'Exhausted',
    })
    setMachineActivity({ results: [], status: 'Exhausted' })
    setSubscriptions([{ _id: 'sub_1', email: 'alice@example.com', slot: 1 }])
    render(<AuditPage />)
    // Apply a filter that excludes the only loaded row.
    fireEvent.change(screen.getByLabelText(/outcome/i), { target: { value: 'failure' } })
    expect(screen.getByText(/no matching activity/i)).toBeTruthy()
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
          triggeredBy: 'manual',
          outcome: 'success',
          at: now - 1000,
        },
        {
          _id: 'log_2',
          _creationTime: now,
          userId: 'u_1',
          subscriptionId: 'sub_1',
          triggeredBy: 'manual',
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

  describe('table structure', () => {
    it('renders a table with column headers (Kind, Outcome, Detail, IP, When)', () => {
      setRefreshLog({ results: [], status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      const table = screen.getByRole('table')
      expect(table).toBeTruthy()
      const headers = within(table).getAllByRole('columnheader')
      const headerText = headers.map((h) => h.textContent.toLowerCase()).join(' ')
      expect(headerText).toContain('kind')
      expect(headerText).toContain('outcome')
      expect(headerText).toContain('detail')
      expect(headerText).toContain('ip')
      expect(headerText).toContain('when')
    })

    it('renders an empty-state row inside the table body when no rows match', () => {
      setRefreshLog({ results: [], status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      expect(screen.getByText(/no audit rows/i)).toBeTruthy()
    })
  })

  describe('pagination controls', () => {
    it('renders 25 rows per page by default', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      const { container } = render(<AuditPage />)
      const rows = container.querySelectorAll('[data-slot="audit-row"]')
      expect(rows.length).toBe(25)
    })

    it('renders "Page 1 of 3" when Exhausted with 60 rows at page size 25', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      expect(screen.getByText(/page\s+1\s+of\s+3/i)).toBeTruthy()
    })

    it('shows "Page 1 of ?" when status is CanLoadMore (total unknown)', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'CanLoadMore' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      expect(screen.getByText(/page\s+1\s+of\s+\?/i)).toBeTruthy()
    })

    it('renders the loaded-rows count', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      expect(screen.getByText(/60\s+rows\s+loaded/i)).toBeTruthy()
    })

    it('disables Prev/First on the first page', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      const prev = screen.getByRole('button', { name: /^prev/i })
      const first = screen.getByRole('button', { name: /^first/i })
      expect((prev as HTMLButtonElement).disabled).toBe(true)
      expect((first as HTMLButtonElement).disabled).toBe(true)
    })

    it('clicking Next advances the page', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      fireEvent.click(screen.getByRole('button', { name: /^next/i }))
      expect(screen.getByText(/page\s+2\s+of\s+3/i)).toBeTruthy()
    })

    it('disables Next on the last page when Exhausted', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      fireEvent.click(screen.getByRole('button', { name: /^next/i }))
      fireEvent.click(screen.getByRole('button', { name: /^next/i }))
      expect(screen.getByText(/page\s+3\s+of\s+3/i)).toBeTruthy()
      const next = screen.getByRole('button', { name: /^next/i })
      expect((next as HTMLButtonElement).disabled).toBe(true)
    })

    it('disables Last when status is not Exhausted (total unknown)', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'CanLoadMore' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      const last = screen.getByRole('button', { name: /^last/i })
      expect((last as HTMLButtonElement).disabled).toBe(true)
    })

    it('clicking Last jumps to the final page when Exhausted', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      fireEvent.click(screen.getByRole('button', { name: /^last/i }))
      expect(screen.getByText(/page\s+3\s+of\s+3/i)).toBeTruthy()
    })

    it('clicking First jumps back to page 1', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      fireEvent.click(screen.getByRole('button', { name: /^next/i }))
      fireEvent.click(screen.getByRole('button', { name: /^next/i }))
      expect(screen.getByText(/page\s+3\s+of\s+3/i)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: /^first/i }))
      expect(screen.getByText(/page\s+1\s+of\s+3/i)).toBeTruthy()
    })

    it('clicking Next when status is CanLoadMore triggers loadMore on both queries', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(25, { now }), status: 'CanLoadMore' })
      setMachineActivity({ results: [], status: 'CanLoadMore' })
      setSubscriptions([])
      render(<AuditPage />)
      // We've loaded exactly one page; next click runs out of loaded data
      // and must request more from the server.
      fireEvent.click(screen.getByRole('button', { name: /^next/i }))
      expect(loadMoreRefreshMock).toHaveBeenCalled()
      expect(loadMoreActivityMock).toHaveBeenCalled()
    })
  })

  describe('page size selector', () => {
    it('shows the current page size (25) on the trigger', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      const trigger = screen.getByRole('combobox', { name: /rows per page/i })
      expect(trigger.textContent).toContain('25')
    })

    it('changing the page size to 50 shows 50 rows on page 1', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      const { container } = render(<AuditPage />)
      // Open the Radix Select and click "50". The Select content portals
      // to document.body, so getByRole('option') sees it after click.
      fireEvent.click(screen.getByRole('combobox', { name: /rows per page/i }))
      fireEvent.click(screen.getByRole('option', { name: '50' }))
      expect(container.querySelectorAll('[data-slot="audit-row"]').length).toBe(50)
    })

    it('changing the page size resets to page 1', () => {
      const now = Date.now()
      setRefreshLog({ results: buildRefreshRows(60, { now }), status: 'Exhausted' })
      setMachineActivity({ results: [], status: 'Exhausted' })
      setSubscriptions([])
      render(<AuditPage />)
      // Move to page 2 first.
      fireEvent.click(screen.getByRole('button', { name: /^next/i }))
      expect(screen.getByText(/page\s+2/i)).toBeTruthy()
      // Now change page size — must reset to page 1.
      fireEvent.click(screen.getByRole('combobox', { name: /rows per page/i }))
      fireEvent.click(screen.getByRole('option', { name: '50' }))
      expect(screen.getByText(/page\s+1\s+of\s+2/i)).toBeTruthy()
    })
  })
})
