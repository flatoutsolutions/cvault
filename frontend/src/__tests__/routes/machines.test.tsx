/**
 * /dashboard/machines tests.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §11.
 *
 * Mocks `useQuery` for devices.listForUser and `useAction` for revokeDevice.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MachinesPage } from '../../routes/dashboard/machines.lazy'

let devicesResult: unknown = undefined
const revokeMock = vi.fn().mockResolvedValue({ revoked: true })

vi.mock('convex/react', () => ({
  useQuery: () => devicesResult,
  useAction: () => revokeMock,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
  createLazyFileRoute: () => () => ({}),
}))

describe('/dashboard/machines', () => {
  beforeEach(() => {
    devicesResult = undefined
    revokeMock.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders skeletons while the devices query is loading', () => {
    devicesResult = undefined
    const { container } = render(<MachinesPage />)
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('renders an empty state when there are zero devices', () => {
    devicesResult = []
    render(<MachinesPage />)
    expect(screen.getByText(/no machines have used the vault/i)).toBeTruthy()
  })

  it('renders a row per device', () => {
    const now = Date.now()
    devicesResult = [
      {
        machineId: 'mach-111aaa222bbb',
        lastSeenAt: now - 60_000,
        label: 'macbook-air',
        revokedAt: undefined,
      },
      {
        machineId: 'mach-999zzz888yyy',
        lastSeenAt: now - 5 * 60_000,
        label: undefined,
        revokedAt: undefined,
      },
    ]
    const { container } = render(<MachinesPage />)
    expect(container.querySelectorAll('[data-slot="machine-row"]').length).toBe(2)
  })

  it('renders multiple machines with their labels as primary text', () => {
    const now = Date.now()
    devicesResult = [
      {
        machineId: 'mach-111aaa222bbb',
        lastSeenAt: now - 60_000,
        label: 'macbook-air',
        revokedAt: undefined,
      },
      {
        machineId: 'mach-222bbb333ccc',
        lastSeenAt: now - 5 * 60_000,
        label: 'desktop-linux',
        revokedAt: undefined,
      },
      {
        machineId: 'mach-999zzz888yyy',
        lastSeenAt: now - 10 * 60_000,
        label: undefined,
        revokedAt: undefined,
      },
    ]
    render(<MachinesPage />)
    expect(screen.getByText('macbook-air')).toBeTruthy()
    expect(screen.getByText('desktop-linux')).toBeTruthy()
    expect(screen.getByText('(no label)')).toBeTruthy()
  })

  it('calls the revoke action with the clicked machine id', async () => {
    const now = Date.now()
    devicesResult = [
      {
        machineId: 'mach-111aaa222bbb',
        lastSeenAt: now,
        label: 'work-laptop',
        revokedAt: undefined,
      },
    ]
    render(<MachinesPage />)

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    await waitFor(() => {
      expect(revokeMock).toHaveBeenCalledWith({ machineId: 'mach-111aaa222bbb' })
    })
  })

  it('renders an inline error block when the revoke action throws', async () => {
    const now = Date.now()
    devicesResult = [
      {
        machineId: 'mach-111aaa222bbb',
        lastSeenAt: now,
        label: 'work-laptop',
        revokedAt: undefined,
      },
    ]
    revokeMock.mockRejectedValueOnce(new Error('REVOKE_BACKEND_ERROR: 429'))
    render(<MachinesPage />)

    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    await waitFor(() => {
      expect(screen.getByText(/REVOKE_BACKEND_ERROR/)).toBeTruthy()
    })
  })

  it('disables the revoke button for a device that is already revoked', () => {
    const now = Date.now()
    devicesResult = [
      {
        machineId: 'mach-revoked',
        lastSeenAt: now - 5000,
        label: 'old-machine',
        revokedAt: now - 1000,
      },
    ]
    render(<MachinesPage />)
    const button = screen.getByRole('button', { name: /revok/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/revoked/i)).toBeTruthy()
  })

  it('keeps each device row distinct by machineId', () => {
    const now = Date.now()
    devicesResult = [
      {
        machineId: 'mach-aaa',
        lastSeenAt: now,
        label: 'machine-a',
        revokedAt: undefined,
      },
      {
        machineId: 'mach-bbb',
        lastSeenAt: now - 1000,
        label: 'machine-b',
        revokedAt: undefined,
      },
    ]
    const { container } = render(<MachinesPage />)
    const rows = container.querySelectorAll('[data-slot="machine-row"]')
    expect(rows.length).toBe(2)
    expect(screen.getByText('machine-a')).toBeTruthy()
    expect(screen.getByText('machine-b')).toBeTruthy()
  })
})
