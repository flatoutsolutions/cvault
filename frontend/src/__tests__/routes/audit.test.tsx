/**
 * /dashboard/audit — human-readable activity feed tests.
 *
 * The page makes two Convex queries (routed by ref name in the mock):
 *   - api.audit.feed.recentFeed          → { events, capped }
 *   - api.subscriptions.queries.listForUser → sub list (health strip + filter)
 *
 * Verifies: loading + empty states, plain-language rows with actor/machine,
 * routine-hiding default + toggle, status filtering, the health strip, the
 * capped note, and client-side pagination over the bounded window.
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
let subsResult: unknown = []

vi.mock('convex/react', () => ({
  useQuery: (ref: unknown) => (refToName(ref).includes('recentFeed') ? feedResult : subsResult),
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
    subsResult = []
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a skeleton while the feed query is loading', () => {
    feedResult = undefined
    const { container } = render(<AuditPage />)
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('renders an empty-state when there is no activity', () => {
    setFeed([])
    render(<AuditPage />)
    expect(screen.getByText(/no activity yet/i)).toBeTruthy()
  })

  it('renders a plain-language row with actor, sub, and machine label', () => {
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

  it('hides routine events (successful refresh, bulk pull) by default and reveals them on toggle', () => {
    setFeed([
      activity({ id: 'sw', action: 'switch', actor: { userId: 'u1', name: 'Alice Tester' } }),
      refresh({ id: 'ok', outcome: 'success' }),
      activity({ id: 'pl', action: 'pull', actor: { userId: 'u1', name: 'Alice Tester' } }),
    ])
    const { container } = render(<AuditPage />)
    // Only the switch (non-routine) shows by default.
    expect(container.querySelectorAll('[data-slot="audit-row"]')).toHaveLength(1)
    expect(screen.getByText('Switched subscription')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /show routine events/i }))
    expect(container.querySelectorAll('[data-slot="audit-row"]')).toHaveLength(3)
    expect(screen.getByText('Token refreshed')).toBeTruthy()
    expect(screen.getByText('Synced credentials')).toBeTruthy()
  })

  it('filters to failed events via the Status filter', () => {
    setFeed([
      activity({ id: 'sw', action: 'switch', actor: { userId: 'u1', name: 'Alice Tester' } }),
      refresh({ id: 'bad', outcome: 'failure', error: 'Anthropic 500', subEmail: 'team@acme.com' }),
    ])
    const { container } = render(<AuditPage />)
    // Failure is non-routine, so both rows show initially.
    expect(container.querySelectorAll('[data-slot="audit-row"]')).toHaveLength(2)

    fireEvent.click(screen.getByRole('combobox', { name: /filter by status/i }))
    fireEvent.click(screen.getByRole('option', { name: 'Failed' }))

    const rows = container.querySelectorAll('[data-slot="audit-row"]')
    expect(rows).toHaveLength(1)
    expect(screen.getByText('Token refresh failed')).toBeTruthy()
    expect(screen.getByText('Anthropic 500')).toBeTruthy()
  })

  it('shows a healthy summary strip when no subscription needs attention', () => {
    setFeed([refresh({ outcome: 'success', subEmail: 'team@acme.com' })])
    // refreshExpiresAt must be in the real future — the page compares against
    // Date.now(), not the test's fixed NOW.
    subsResult = [{ _id: 's1', email: 'team@acme.com', refreshExpiresAt: Date.now() + 86_400_000 }]
    render(<AuditPage />)
    expect(screen.getByText(/vault healthy/i)).toBeTruthy()
  })

  it('warns in the summary strip when a subscription grant has lapsed', () => {
    setFeed([activity({ actor: { userId: 'u1', name: 'Alice Tester' } })])
    subsResult = [{ _id: 's1', email: 'team@acme.com', refreshExpiresAt: NOW - 1000 }]
    render(<AuditPage />)
    expect(screen.getByText(/needs attention/i)).toBeTruthy()
  })

  it('warns when a sub’s latest refresh failed even though its grant has not lapsed', () => {
    // The strip must not contradict the feed: a failing refresh below should
    // never coexist with a green "healthy" strip just because the stored
    // grant timestamp is still in the future.
    setFeed([refresh({ id: 'bad', outcome: 'failure', error: 'boom', subEmail: 'team@acme.com' })])
    subsResult = [{ _id: 's1', email: 'team@acme.com', refreshExpiresAt: Date.now() + 86_400_000 }]
    render(<AuditPage />)
    expect(screen.getByText(/needs attention/i)).toBeTruthy()
  })

  it('stays healthy when a later success supersedes an earlier failure for the same sub', () => {
    // Events are newest-first; the most-recent outcome per sub decides health.
    setFeed([
      refresh({ id: 'ok', at: NOW - 1000, outcome: 'success', subEmail: 'team@acme.com' }),
      refresh({ id: 'bad', at: NOW - 5000, outcome: 'failure', error: 'boom', subEmail: 'team@acme.com' }),
    ])
    subsResult = [{ _id: 's1', email: 'team@acme.com', refreshExpiresAt: Date.now() + 86_400_000 }]
    render(<AuditPage />)
    expect(screen.getByText(/vault healthy/i)).toBeTruthy()
  })

  it('notes when the feed is capped at the recent window', () => {
    setFeed([activity({ actor: { userId: 'u1', name: 'Alice Tester' } })], true)
    render(<AuditPage />)
    expect(screen.getByText(/most recent 500/i)).toBeTruthy()
  })

  it('tells the user older history is not searched when a filter empties a capped window', () => {
    // Only a routine pull is in-window, hidden by default → filtered view is
    // empty. Because the window is capped, the empty state must not imply
    // nothing exists; it should say older history was not searched.
    setFeed([activity({ id: 'pl', action: 'pull', actor: { userId: 'u1', name: 'Alice Tester' } })], true)
    render(<AuditPage />)
    expect(screen.getByText(/older history is not searched/i)).toBeTruthy()
  })

  it('uses the plain filters empty-state when the window is not capped', () => {
    setFeed([activity({ id: 'pl', action: 'pull', actor: { userId: 'u1', name: 'Alice Tester' } })], false)
    render(<AuditPage />)
    expect(screen.getByText(/no events match the current filters/i)).toBeTruthy()
  })

  it('paginates the window at 25 rows per page by default', () => {
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

  it('renders System as the actor for automatic refresh events', () => {
    setFeed([refresh({ outcome: 'failure', error: 'boom', subEmail: 'team@acme.com' })])
    render(<AuditPage />)
    expect(screen.getByText(/system/i)).toBeTruthy()
  })
})
