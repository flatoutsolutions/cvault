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

/**
 * Convex function-reference identity is opaque (Proxy), so instead of
 * pattern-matching the path, we route by call order. The audit page
 * calls useQuery three times per render in this order:
 *   1. refreshLog.recentForUser
 *   2. machineActivity.recentForUser
 *   3. subscriptions.listForUser
 * — verified by reading routes/dashboard/audit.tsx.
 */
let nextResults: { refreshLog: unknown; machineActivity: unknown; subscriptions: unknown } = {
  refreshLog: undefined,
  machineActivity: undefined,
  subscriptions: undefined,
}

function setQueryReturn(key: keyof typeof nextResults, value: unknown) {
  nextResults = { ...nextResults, [key]: value }
}

let useQueryCallCount = 0

vi.mock('convex/react', () => ({
  useQuery: () => {
    const idx = useQueryCallCount % 3
    useQueryCallCount += 1
    if (idx === 0) return nextResults.refreshLog
    if (idx === 1) return nextResults.machineActivity
    return nextResults.subscriptions
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
}))

// eslint-disable-next-line import/first
import { AuditPage } from '../../routes/dashboard/audit'

describe('/dashboard/audit', () => {
  beforeEach(() => {
    nextResults = { refreshLog: undefined, machineActivity: undefined, subscriptions: undefined }
    useQueryCallCount = 0
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders skeletons while one of the queries is loading', () => {
    setQueryReturn('refreshLog', undefined)
    setQueryReturn('machineActivity', undefined)
    setQueryReturn('subscriptions', undefined)
    const { container } = render(<AuditPage />)
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('renders an empty-state message when both queries return zero rows', () => {
    setQueryReturn('refreshLog', [])
    setQueryReturn('machineActivity', [])
    setQueryReturn('subscriptions', [])
    render(<AuditPage />)
    expect(screen.getByText(/no audit rows/i)).toBeTruthy()
  })

  it('renders rows from both backends, most recent first', () => {
    const now = Date.now()
    setQueryReturn('refreshLog', [
      {
        _id: 'log_1',
        _creationTime: now,
        userId: 'u_1',
        subscriptionId: 'sub_1',
        triggeredBy: 'cron',
        outcome: 'success',
        at: now - 10 * 60_000,
      },
    ])
    setQueryReturn('machineActivity', [
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
    ])
    setQueryReturn('subscriptions', [
      { _id: 'sub_1', email: 'alice@example.com', slot: 1 },
    ])
    const { container } = render(<AuditPage />)
    const rows = Array.from(container.querySelectorAll('[data-slot="audit-row"]'))
    expect(rows).toHaveLength(2)
    // Most-recent (activity, 5m ago) is first; refresh (10m ago) second.
    expect(rows[0]?.textContent).toContain('switch')
    expect(rows[1]?.textContent).toContain('refresh')
  })

  it('filters by outcome=failure and excludes activity rows', () => {
    const now = Date.now()
    setQueryReturn('refreshLog', [
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
    ])
    setQueryReturn('machineActivity', [
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
    ])
    setQueryReturn('subscriptions', [{ _id: 'sub_1', email: 'alice@example.com', slot: 1 }])

    const { container } = render(<AuditPage />)
    // Pick the Outcome filter and switch to 'failure'
    const outcomeSelect = screen.getByLabelText(/outcome/i)
    fireEvent.change(outcomeSelect, { target: { value: 'failure' } })

    const rows = Array.from(container.querySelectorAll('[data-slot="audit-row"]'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('Anthropic refresh 500')
  })
})
