/**
 * /dashboard/audit — human-readable activity feed tests.
 *
 * The page makes four Convex queries (routed by ref name in the mock):
 *   - api.audit.feed.recentFeed          → { events, capped }  (FILTERED server-side)
 *   - api.audit.feed.feedSummary         → health strip (filter-independent)
 *   - api.subscriptions.queries.listForUser → Sub filter options
 *   - api.devices.queries.listForUser    → Machine filter options
 *
 * Because filtering now happens on the server, these tests verify that the page
 * (a) passes the selected filters to recentFeed as query args, (b) renders
 * whatever rows the server returns, (c) drives the health strip from
 * feedSummary, and (d) shows the right empty-state copy. The filtering logic
 * itself is covered in convex/audit/feed.test.ts.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuditPage } from '../../routes/dashboard/audit.lazy'

function refToName(ref: unknown): string {
  const r = ref as Record<string | symbol, unknown>
  if (typeof r._functionPath === 'string') return r._functionPath
  const sym = Symbol.for('functionName')
  const v = r[sym]
  return typeof v === 'string' ? v : 'default'
}

let feedResult: unknown = { events: [], capped: false }
let summaryResult: unknown = { needsAttention: 0, activeMachines: 0, lastRefreshAt: undefined }
let subsResult: unknown = []
let devicesResult: unknown = []
let lastFeedArgs: Record<string, unknown> | undefined

vi.mock('convex/react', () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = refToName(ref)
    if (name.includes('recentFeed')) {
      lastFeedArgs = args as Record<string, unknown>
      return feedResult
    }
    if (name.includes('feedSummary')) return summaryResult
    if (name.includes('devices')) return devicesResult
    return subsResult
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
  createLazyFileRoute: () => () => ({}),
}))

// Radix Select needs these DOM methods that jsdom lacks; without them the
// dropdown throws on open. Global no-ops — the page doesn't rely on semantics.
beforeAll(() => {
  if (typeof Element.prototype.hasPointerCapture !== 'function') Element.prototype.hasPointerCapture = () => false
  if (typeof Element.prototype.releasePointerCapture !== 'function')
    Element.prototype.releasePointerCapture = () => undefined
  if (typeof Element.prototype.scrollIntoView !== 'function') Element.prototype.scrollIntoView = () => undefined
})

const NOW = 1_700_000_000_000

function activity(over: Record<string, unknown> = {}) {
  return { kind: 'activity', id: 'a1', at: NOW - 60_000, action: 'switch', machineId: 'mac-1', ...over }
}
function refresh(over: Record<string, unknown> = {}) {
  return { kind: 'refresh', id: 'r1', at: NOW - 120_000, outcome: 'success', triggeredBy: 'onUse', ...over }
}

function setFeed(events: unknown[], capped = false) {
  feedResult = { events, capped }
}

describe('/dashboard/audit', () => {
  beforeEach(() => {
    feedResult = { events: [], capped: false }
    summaryResult = { needsAttention: 0, activeMachines: 0, lastRefreshAt: undefined }
    subsResult = []
    devicesResult = []
    lastFeedArgs = undefined
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a skeleton while the feed query is loading', () => {
    feedResult = undefined
    const { container } = render(<AuditPage />)
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('renders the rows the server returns', () => {
    setFeed([
      activity({
        action: 'switch',
        subEmail: 'team@acme.com',
        machineLabel: "Alice's MacBook",
        actor: { userId: 'u1', name: 'Alice Tester' },
      }),
    ])
    const { container } = render(<AuditPage />)
    expect(container.querySelectorAll('[data-slot="audit-row"]')).toHaveLength(1)
    expect(screen.getByText('Switched subscription')).toBeTruthy()
    expect(screen.getByText('Alice Tester')).toBeTruthy()
    expect(screen.getByText('team@acme.com')).toBeTruthy()
    expect(screen.getByText("Alice's MacBook")).toBeTruthy()
  })

  it('renders System as the actor for automatic refresh events', () => {
    setFeed([refresh({ outcome: 'failure', error: 'boom', subEmail: 'team@acme.com' })])
    render(<AuditPage />)
    expect(screen.getByText(/system/i)).toBeTruthy()
  })

  it('hides routine events by default by asking the server (includeRoutine: false)', () => {
    render(<AuditPage />)
    expect(lastFeedArgs?.includeRoutine).toBe(false)
  })

  it('asks the server to include routine events when the toggle is pressed', () => {
    render(<AuditPage />)
    fireEvent.click(screen.getByRole('button', { name: /show routine events/i }))
    expect(lastFeedArgs?.includeRoutine).toBe(true)
  })

  it('passes the chosen status filter to the server query', () => {
    render(<AuditPage />)
    fireEvent.click(screen.getByRole('combobox', { name: /filter by status/i }))
    fireEvent.click(screen.getByRole('option', { name: 'Failed' }))
    expect(lastFeedArgs?.status).toBe('failed')
  })

  it('passes the chosen subscription filter to the server query', () => {
    subsResult = [{ _id: 's1', email: 'team@acme.com' }]
    render(<AuditPage />)
    fireEvent.click(screen.getByRole('combobox', { name: /filter by subscription/i }))
    fireEvent.click(screen.getByRole('option', { name: 'team@acme.com' }))
    expect(lastFeedArgs?.sub).toBe('team@acme.com')
  })

  it('builds Machine filter options from the device registry, not the feed', () => {
    devicesResult = [{ machineId: 'mac-1', label: "Alice's MacBook", lastSeenAt: 1 }]
    setFeed([]) // empty feed — the option must still come from devices
    render(<AuditPage />)
    fireEvent.click(screen.getByRole('combobox', { name: /filter by machine/i }))
    fireEvent.click(screen.getByRole('option', { name: "Alice's MacBook" }))
    expect(lastFeedArgs?.machine).toBe('mac-1')
  })

  it('shows a healthy summary strip when feedSummary reports no attention needed', () => {
    summaryResult = { needsAttention: 0, activeMachines: 2, lastRefreshAt: Date.now() }
    render(<AuditPage />)
    expect(screen.getByText(/vault healthy/i)).toBeTruthy()
    expect(screen.getByText(/2 machines active/i)).toBeTruthy()
    expect(screen.getByText(/last refresh/i)).toBeTruthy()
  })

  it('warns in the summary strip when feedSummary reports subs needing attention', () => {
    summaryResult = { needsAttention: 2, activeMachines: 1, lastRefreshAt: undefined }
    render(<AuditPage />)
    expect(screen.getByText(/2 subscriptions need attention/i)).toBeTruthy()
  })

  it('notes when the feed is capped at the recent window', () => {
    setFeed([activity({ actor: { userId: 'u1', name: 'Alice Tester' } })], true)
    render(<AuditPage />)
    expect(screen.getByText(/most recent 500/i)).toBeTruthy()
  })

  it('points at the routine toggle when the unfiltered feed is empty', () => {
    setFeed([])
    render(<AuditPage />)
    expect(screen.getByText(/routine events.*are hidden/i)).toBeTruthy()
  })

  it('shows a plain empty-state when routine events are also shown', () => {
    setFeed([])
    render(<AuditPage />)
    fireEvent.click(screen.getByRole('button', { name: /show routine events/i }))
    expect(screen.getByText(/no activity yet/i)).toBeTruthy()
  })

  it('tells the user older history was not fully searched when a filter empties a capped feed', () => {
    setFeed([], true)
    render(<AuditPage />)
    fireEvent.click(screen.getByRole('combobox', { name: /filter by status/i }))
    fireEvent.click(screen.getByRole('option', { name: 'Failed' }))
    expect(screen.getByText(/older history was not fully searched/i)).toBeTruthy()
  })

  it('shows the plain no-match copy when a filter empties an uncapped feed', () => {
    setFeed([], false)
    render(<AuditPage />)
    fireEvent.click(screen.getByRole('combobox', { name: /filter by status/i }))
    fireEvent.click(screen.getByRole('option', { name: 'Failed' }))
    expect(screen.getByText(/no events match the current filters/i)).toBeTruthy()
  })

  it('paginates the returned matches at 25 rows per page by default', () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      activity({ id: `a${i.toString()}`, at: NOW - i * 60_000, actor: { userId: 'u1', name: 'Alice Tester' } })
    )
    setFeed(events)
    const { container } = render(<AuditPage />)
    expect(container.querySelectorAll('[data-slot="audit-row"]')).toHaveLength(25)
    expect(screen.getByText(/page\s+1\s+of\s+2/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /next page/i }))
    expect(container.querySelectorAll('[data-slot="audit-row"]')).toHaveLength(5)
    expect(screen.getByText(/page\s+2\s+of\s+2/i)).toBeTruthy()
  })
})
