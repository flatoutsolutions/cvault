/**
 * Scenario #11 — `/dashboard/machines` Revoke button.
 *
 * Plan: docs/research/scenario-tests-plan.md §4.11 (frontend half).
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8 (machines page,
 *       Revoke action) and §7 (CLI handling of revoked Clerk session).
 *
 * Existing route-level coverage at
 * frontend/src/__tests__/routes/machines.test.tsx asserts that the revoke
 * action is called with the clicked session id. This scenario tightens
 * the wire and tests the live-query update on success: after a successful
 * revoke, the next `useQuery` snapshot omits that session and the row
 * disappears from the table.
 *
 * Cross-tenant note: local-reviewer-2026-05-02.md §C1 flagged that the
 * shipped `cli.actions.revokeSession` doesn't verify session ownership.
 * That is a backend-side concern; this scenario covers the frontend
 * dispatch contract and is independent of the C1 fix. (The frontend's
 * behavior is identical regardless of whether the backend rejects: in the
 * happy path the row leaves the list; in the rejected path the inline
 * error renders. Both branches are asserted below.)
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line import/first
import { MachinesPage } from '../../src/routes/dashboard/machines'

let sessionsResult: unknown = undefined
const revokeMock = vi.fn()

// Track the action ref the route registered so the test can defend
// against future renames of `cli.actions.revokeSession`.
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
  useQuery: () => sessionsResult,
  useAction: (ref: unknown) => {
    actionRefsSeen.push({ name: safeFunctionName(ref) })
    return revokeMock
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
}))

function makeSession(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    clerkSessionId: 'sess_111aaa222bbb',
    lastSeenAt: now - 60_000,
    lastIpHash: 'a1b2c3d4',
    ...overrides,
  }
}

describe('scenario / revoke machine', () => {
  beforeEach(() => {
    sessionsResult = undefined
    revokeMock.mockReset()
    revokeMock.mockResolvedValue({ revoked: true })
    actionRefsSeen.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('dispatches api.cli.actions.revokeSession with the clicked clerkSessionId', async () => {
    sessionsResult = [makeSession({ clerkSessionId: 'sess_target_xyz' })]

    render(<MachinesPage />)

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))

    await waitFor(() => {
      expect(revokeMock).toHaveBeenCalledTimes(1)
    })

    expect(revokeMock.mock.calls[0]?.[0]).toEqual({ clerkSessionId: 'sess_target_xyz' })
  })

  it('passes the api.cli.actions.revokeSession action reference to useAction', () => {
    sessionsResult = [makeSession()]
    render(<MachinesPage />)

    // Defends against a rename to e.g. `cli.actions.revoke` or moving the
    // action to a different module.
    expect(actionRefsSeen.some((r) => r.name.includes('revokeSession'))).toBe(true)
  })

  it('disables the Revoke button while the action is in-flight', async () => {
    sessionsResult = [makeSession({ clerkSessionId: 'sess_inflight' })]

    let resolveRevoke: (() => void) | undefined
    revokeMock.mockImplementation(
      () =>
        new Promise<{ revoked: true }>((resolve) => {
          resolveRevoke = () => resolve({ revoked: true })
        })
    )

    render(<MachinesPage />)

    const revokeBtn = screen.getByRole('button', { name: /revoke/i })
    expect(revokeBtn.hasAttribute('disabled')).toBe(false)
    fireEvent.click(revokeBtn)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /revoking/i }).hasAttribute('disabled')).toBe(true)
    })

    resolveRevoke?.()
  })

  it('removes the row from the list after the live query reflects the revoke', async () => {
    // Phase 1: two sessions, both visible.
    sessionsResult = [
      makeSession({ clerkSessionId: 'sess_target_aaa', lastIpHash: 'ip_a' }),
      makeSession({ clerkSessionId: 'sess_other_bbb', lastIpHash: 'ip_b' }),
    ]

    const { container, rerender } = render(<MachinesPage />)
    expect(container.querySelectorAll('[data-slot="machine-row"]').length).toBe(2)

    // Revoke the first session.
    const revokeBtns = screen.getAllByRole('button', { name: /revoke/i })
    if (!revokeBtns[0]) throw new Error('expected at least 1 revoke button')
    fireEvent.click(revokeBtns[0])

    await waitFor(() => {
      expect(revokeMock).toHaveBeenCalledWith({ clerkSessionId: 'sess_target_aaa' })
    })

    // Phase 2: backend has revoked + the audit/distinct-sessions query
    // re-runs and excludes the revoked session. (The shipped query is
    // `distinctSessionsForUser` over machineActivity; on Clerk-side
    // session revocation, follow-up CLI calls fail — so subsequent audit
    // rows are not appended for that session, and depending on the page's
    // exact semantics it may or may not still appear in the list. This
    // scenario asserts the realistic post-revoke snapshot: the row is
    // gone.)
    sessionsResult = [makeSession({ clerkSessionId: 'sess_other_bbb', lastIpHash: 'ip_b' })]
    rerender(<MachinesPage />)

    expect(container.querySelectorAll('[data-slot="machine-row"]').length).toBe(1)
  })

  it('renders the inline error block when revokeSession throws', async () => {
    sessionsResult = [makeSession({ clerkSessionId: 'sess_will_fail' })]
    revokeMock.mockRejectedValueOnce(new Error('CLERK_BACKEND_ERROR: 429 too many requests'))

    render(<MachinesPage />)

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))

    await waitFor(() => {
      expect(screen.getByText(/CLERK_BACKEND_ERROR/)).toBeTruthy()
    })
    // The throwing call still counted as a dispatch — verifies the user's
    // intent reached the action layer (the failure is server-side).
    expect(revokeMock).toHaveBeenCalledTimes(1)
  })

  it('only revokes the clicked session when multiple sessions are present', async () => {
    sessionsResult = [
      makeSession({ clerkSessionId: 'sess_keep_111' }),
      makeSession({ clerkSessionId: 'sess_doomed_222' }),
      makeSession({ clerkSessionId: 'sess_also_keep_333' }),
    ]

    render(<MachinesPage />)

    const buttons = screen.getAllByRole('button', { name: /revoke/i })
    expect(buttons).toHaveLength(3)
    // Click the middle row.
    if (!buttons[1]) throw new Error('expected at least 2 revoke buttons')
    fireEvent.click(buttons[1])

    await waitFor(() => {
      expect(revokeMock).toHaveBeenCalledTimes(1)
    })
    expect(revokeMock.mock.calls[0]?.[0]).toEqual({ clerkSessionId: 'sess_doomed_222' })
  })
})
