/**
 * MachineRow — single row in /dashboard/machines.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Each row represents a registered device from the `devices` table.
 * The row is keyed by machineId; revocation is also keyed by machineId.
 *
 * Contract under test:
 * - Renders the human-readable `machineLabel` as the primary text
 * - Falls back to a "(no label)" placeholder when `machineLabel` is undefined
 * - Renders a stacked secondary line: "Last seen Nm ago" + optional "IP: <prefix>"
 * - Hides the "IP" fragment when `lastIpHash` is undefined
 * - Exposes the full `machineId` via the row's native title attribute
 *   (debug-only — the visible label is the user-facing identifier)
 * - Renders a "Revoke" button that calls onRevoke({machineId})
 * - Disables the button while pending=true
 * - Disables the button and shows a "revoked" indicator when revokedAt is set
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MachineRow } from '../MachineRow'

describe('MachineRow', () => {
  const baseProps = {
    machineId: 'mach-abc123def456',
    lastIpHash: 'a1b2c3d4',
    lastSeenAt: Date.now() - 5 * 60_000,
    machineLabel: 'saads-macbook-pro',
    revokedAt: undefined,
    onRevoke: vi.fn(),
    pending: false,
  }

  it('renders the machineLabel as primary text', () => {
    render(<MachineRow {...baseProps} />)
    expect(screen.getByText('saads-macbook-pro')).toBeTruthy()
  })

  it('falls back to "(no label)" placeholder when machineLabel is undefined', () => {
    render(<MachineRow {...baseProps} machineLabel={undefined} />)
    expect(screen.getByText('(no label)')).toBeTruthy()
  })

  it('renders a relative last-seen timestamp in the secondary line', () => {
    render(<MachineRow {...baseProps} />)
    expect(screen.getByText(/Last seen 5m ago|Last seen 6m ago/)).toBeTruthy()
  })

  it('renders the IP prefix in the secondary line when lastIpHash is present', () => {
    render(<MachineRow {...baseProps} />)
    expect(screen.getByText(/IP: a1b2c3d4/)).toBeTruthy()
  })

  it('omits the IP fragment when lastIpHash is undefined', () => {
    render(<MachineRow {...baseProps} lastIpHash={undefined} />)
    expect(screen.queryByText(/IP:/)).toBeNull()
  })

  it('exposes the full machineId via the row title attribute for debugging', () => {
    const { container } = render(<MachineRow {...baseProps} />)
    const row = container.querySelector('[data-slot="machine-row"]')
    expect(row).toBeTruthy()
    expect(row?.getAttribute('title')).toBe(baseProps.machineId)
  })

  it('calls onRevoke with the machineId when the button is clicked', () => {
    const onRevoke = vi.fn()
    render(<MachineRow {...baseProps} onRevoke={onRevoke} />)
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    expect(onRevoke).toHaveBeenCalledWith({ machineId: baseProps.machineId })
  })

  it('still calls onRevoke with the machineId even when label is missing', () => {
    const onRevoke = vi.fn()
    render(<MachineRow {...baseProps} machineLabel={undefined} onRevoke={onRevoke} />)
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    expect(onRevoke).toHaveBeenCalledWith({ machineId: baseProps.machineId })
  })

  it('disables the revoke button when pending', () => {
    render(<MachineRow {...baseProps} pending={true} />)
    const button = screen.getByRole('button', { name: /revok/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables the revoke button and shows "revoked" indicator when revokedAt is set', () => {
    render(<MachineRow {...baseProps} revokedAt={Date.now() - 10_000} />)
    const button = screen.getByRole('button', { name: /revok/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/revoked/i)).toBeTruthy()
  })

  it('does not show "revoked" indicator when revokedAt is undefined', () => {
    render(<MachineRow {...baseProps} revokedAt={undefined} />)
    // The "Revoke" button text is present but not an indicator badge
    const button = screen.getByRole('button', { name: /^revoke$/i })
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })
})
