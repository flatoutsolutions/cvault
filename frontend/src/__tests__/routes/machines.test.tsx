/**
 * /dashboard/machines tests.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §11.
 *
 * Mocks `useQuery` for distinctSessionsForUser and `useAction` for the
 * revoke action.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MachinesPage } from '../../routes/dashboard/machines.lazy'

let sessionsResult: unknown = undefined
const revokeMock = vi.fn().mockResolvedValue({ revoked: true })

vi.mock('convex/react', () => ({
  useQuery: () => sessionsResult,
  useAction: () => revokeMock,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
  createLazyFileRoute: () => () => ({}),
}))

describe('/dashboard/machines', () => {
  beforeEach(() => {
    sessionsResult = undefined
    revokeMock.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders skeletons while the sessions query is loading', () => {
    sessionsResult = undefined
    const { container } = render(<MachinesPage />)
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('renders an empty state when there are zero sessions', () => {
    sessionsResult = []
    render(<MachinesPage />)
    expect(screen.getByText(/no machines have used the vault/i)).toBeTruthy()
  })

  it('renders a row per session', () => {
    const now = Date.now()
    sessionsResult = [
      {
        clerkSessionId: 'sess_111aaa222bbb',
        lastSeenAt: now - 60_000,
        lastIpHash: '1234abcd',
        machineLabel: 'macbook-air',
      },
      {
        clerkSessionId: 'sess_999zzz888yyy',
        lastSeenAt: now - 5 * 60_000,
        lastIpHash: undefined,
        machineLabel: undefined,
      },
    ]
    const { container } = render(<MachinesPage />)
    expect(container.querySelectorAll('[data-slot="machine-row"]').length).toBe(2)
  })

  it('renders multiple machines with their labels as primary text', () => {
    const now = Date.now()
    sessionsResult = [
      {
        clerkSessionId: 'sess_111aaa222bbb',
        lastSeenAt: now - 60_000,
        lastIpHash: '1234abcd',
        machineLabel: 'macbook-air',
      },
      {
        clerkSessionId: 'sess_222bbb333ccc',
        lastSeenAt: now - 5 * 60_000,
        lastIpHash: '5678efgh',
        machineLabel: 'desktop-linux',
      },
      {
        clerkSessionId: 'sess_999zzz888yyy',
        lastSeenAt: now - 10 * 60_000,
        lastIpHash: undefined,
        machineLabel: undefined,
      },
    ]
    render(<MachinesPage />)
    expect(screen.getByText('macbook-air')).toBeTruthy()
    expect(screen.getByText('desktop-linux')).toBeTruthy()
    expect(screen.getByText('(no label)')).toBeTruthy()
  })

  it('calls the revoke action with the clicked session id', async () => {
    const now = Date.now()
    sessionsResult = [
      { clerkSessionId: 'sess_111aaa222bbb', lastSeenAt: now, lastIpHash: 'abcd', machineLabel: 'work-laptop' },
    ]
    render(<MachinesPage />)

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    await waitFor(() => {
      expect(revokeMock).toHaveBeenCalledWith({ clerkSessionId: 'sess_111aaa222bbb' })
    })
  })

  it('renders an inline error block when the revoke action throws', async () => {
    const now = Date.now()
    sessionsResult = [
      { clerkSessionId: 'sess_111aaa222bbb', lastSeenAt: now, lastIpHash: 'abcd', machineLabel: 'work-laptop' },
    ]
    revokeMock.mockRejectedValueOnce(new Error('CLERK_BACKEND_ERROR: 429'))
    render(<MachinesPage />)

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    await waitFor(() => {
      expect(screen.getByText(/CLERK_BACKEND_ERROR/)).toBeTruthy()
    })
  })
})
