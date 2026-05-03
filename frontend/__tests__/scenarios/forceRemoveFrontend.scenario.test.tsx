/**
 * Scenario #10a — Dashboard "Remove" button (frontend half).
 *
 * Plan: docs/research/scenario-tests-plan.md §4.10 (frontend half).
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8 (per-card
 *       Remove action) and §10 (soft delete via `removedAt` timestamp).
 *
 * Existing route-level coverage at
 * frontend/src/__tests__/routes/dashboard.test.tsx asserts that *some*
 * mutation gets called when Remove is clicked, without verifying that the
 * specific dispatch is `softRemove({ email })`. This scenario tightens
 * the wire assertion: clicking Remove → `softRemove({ email: <clicked> })`.
 *
 * Live-query update: the dashboard wires `useQuery` to
 * `api.subscriptions.queries.listForUser`, which already filters out rows
 * with `removedAt !== undefined` (see convex/subscriptions/queries.ts). We
 * model the post-soft-remove state by changing what the mocked `useQuery`
 * returns and re-rendering — same shape the live query produces.
 *
 * Confirmation step: the spec calls for "click Remove → confirm → soft
 * remove". The current SubscriptionCard does not yet render a confirm
 * dialog before invoking the callback (it dispatches directly on click).
 * The confirmation assertion is therefore marked FIX-PENDING — the test
 * succeeds against either pattern (direct dispatch OR confirm-then-dispatch)
 * by waiting for the dispatch and not asserting an intermediate dialog.
 * A separate `it.todo` reserves the explicit confirmation-required test
 * for when that UX lands.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SubsPage } from '../../src/routes/dashboard/index.lazy'

const useQueryMock = vi.fn()
const renameMock = vi.fn().mockResolvedValue(null)
const softRemoveMock = vi.fn()
const requestRefreshMock = vi.fn().mockResolvedValue(null)

// Track which mutation refs the route registered, so we can assert the
// route is wired specifically against `softRemove` (not just "some mutation").
const mutationRefsSeen: Array<{ name: string }> = []

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
    mutationRefsSeen.push({ name })
    if (name.includes('softRemove')) return softRemoveMock
    return renameMock
  },
  useAction: () => requestRefreshMock,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
  createLazyFileRoute: () => () => ({}),
}))

function makeSub(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    _id: 'sub_remove_target' as unknown as string,
    _creationTime: now - 60_000,
    userId: 'user_1' as unknown as string,
    email: 'doomed@example.com',
    slot: 1,
    label: undefined,
    expiresAt: now + 60 * 60 * 1000,
    refreshExpiresAt: undefined,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
    lastRefreshedAt: now - 30 * 60_000,
    refreshLeaseHolder: undefined,
    refreshLeaseUntil: undefined,
    usage5h: { pct: 10, resetsAt: now + 60 * 60 * 1000, fetchedAt: now },
    usage7d: { pct: 30, resetsAt: now + 6 * 24 * 60 * 60 * 1000, fetchedAt: now },
    removedAt: undefined,
    ...overrides,
  }
}

describe('scenario / force remove (frontend)', () => {
  beforeEach(() => {
    useQueryMock.mockReset()
    softRemoveMock.mockReset()
    softRemoveMock.mockResolvedValue(null)
    renameMock.mockClear()
    requestRefreshMock.mockClear()
    mutationRefsSeen.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('dispatches api.subscriptions.mutations.softRemove with the clicked sub email', async () => {
    useQueryMock.mockReturnValue([makeSub({ email: 'doomed@example.com' })])

    render(<SubsPage />)

    fireEvent.click(screen.getByRole('button', { name: /remove/i }))

    await waitFor(() => {
      expect(softRemoveMock).toHaveBeenCalledTimes(1)
    })

    expect(softRemoveMock.mock.calls[0]?.[0]).toMatchObject({ email: 'doomed@example.com' })
  })

  it('passes the api.subscriptions.mutations.softRemove ref to useMutation', () => {
    useQueryMock.mockReturnValue([makeSub()])
    render(<SubsPage />)

    // Defends against a future rename of softRemove (e.g., to "remove").
    expect(mutationRefsSeen.some((r) => r.name.includes('softRemove'))).toBe(true)
  })

  it('disables the Remove button while the soft-remove call is in-flight', async () => {
    useQueryMock.mockReturnValue([makeSub()])

    let resolveRemove: (() => void) | undefined
    softRemoveMock.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveRemove = () => resolve(null)
        })
    )

    render(<SubsPage />)

    const removeBtn = screen.getByRole('button', { name: /remove/i })
    fireEvent.click(removeBtn)

    // While in-flight, the button shows "Removing…" and is disabled. This
    // is the user-visible signal that the click was registered.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /removing/i }).hasAttribute('disabled')).toBe(true)
    })

    resolveRemove?.()
  })

  it('removes the card from the list after the live query reflects removedAt being set', async () => {
    // Phase 1: pre-removal state, sub is visible.
    useQueryMock.mockReturnValue([
      makeSub({ _id: 'sub_a', email: 'a@x.com' }),
      makeSub({ _id: 'sub_b', email: 'b@x.com', slot: 2 }),
    ])

    const { container, rerender } = render(<SubsPage />)
    expect(container.querySelectorAll('[data-slot="subscription-card"]').length).toBe(2)
    expect(screen.getByText('a@x.com')).toBeTruthy()

    // Click Remove on the first card.
    const removeButtons = screen.getAllByRole('button', { name: /remove/i })
    if (!removeButtons[0]) throw new Error('expected at least 1 remove button')
    fireEvent.click(removeButtons[0])

    await waitFor(() => {
      expect(softRemoveMock).toHaveBeenCalledWith({ email: 'a@x.com' })
    })

    // Phase 2: live query update. The backend's listForUser filters
    // `removedAt !== undefined` (convex/subscriptions/queries.ts), so a
    // realistic post-mutation snapshot is the unchanged second sub only.
    useQueryMock.mockReturnValue([makeSub({ _id: 'sub_b', email: 'b@x.com', slot: 2 })])
    rerender(<SubsPage />)

    expect(container.querySelectorAll('[data-slot="subscription-card"]').length).toBe(1)
    expect(screen.queryByText('a@x.com')).toBeNull()
    expect(screen.getByText('b@x.com')).toBeTruthy()
  })

  it('only removes the clicked sub when multiple subs are present', async () => {
    useQueryMock.mockReturnValue([
      makeSub({ _id: 'sub_keep', email: 'keep@x.com' }),
      makeSub({ _id: 'sub_doomed', email: 'doomed@x.com', slot: 2 }),
      makeSub({ _id: 'sub_also_keep', email: 'alsokeep@x.com', slot: 3 }),
    ])

    render(<SubsPage />)

    // Click the middle card's Remove button.
    const removeButtons = screen.getAllByRole('button', { name: /remove/i })
    expect(removeButtons).toHaveLength(3)
    if (!removeButtons[1]) throw new Error('expected at least 2 remove buttons')
    fireEvent.click(removeButtons[1])

    await waitFor(() => {
      expect(softRemoveMock).toHaveBeenCalledTimes(1)
    })
    expect(softRemoveMock.mock.calls[0]?.[0]).toEqual({ email: 'doomed@x.com' })
  })

  // FIX-PENDING: the spec/system-prompt brief calls for a confirmation
  // step ("click Remove → confirm → soft remove"). The current
  // SubscriptionCard dispatches directly on click without an intermediate
  // confirm dialog. Once that UX lands (likely a `<Dialog>` like the
  // Rename flow already uses), wire this assertion against it.
  it.todo('shows a confirm dialog before dispatching softRemove and only fires after explicit confirmation')
})
