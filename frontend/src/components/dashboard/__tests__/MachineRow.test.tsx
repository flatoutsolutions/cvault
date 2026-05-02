/**
 * MachineRow — single row in /dashboard/machines.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Each row represents a Clerk session that has used the vault
 * (so we get the session id from `machineActivity.distinctSessionsForUser`).
 *
 * The "Revoke" button calls `api.machines.actions.revoke({sessionId})`
 * — that backend action does NOT yet exist (see IMPLEMENTATION_NOTES.md).
 *
 * Contract under test:
 * - Renders the truncated session id
 * - Renders the IP hash and last-seen timestamp
 * - Renders a "Revoke" button
 * - Calls onRevoke({sessionId}) when the button is clicked
 * - Disables the button while pending=true
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MachineRow } from '../MachineRow'

describe('MachineRow', () => {
  const baseProps = {
    clerkSessionId: 'sess_abc123def456',
    lastIpHash: 'a1b2c3d4',
    lastSeenAt: Date.now() - 5 * 60_000,
    onRevoke: vi.fn(),
    pending: false,
  }

  it('renders the truncated session id and IP hash', () => {
    render(<MachineRow {...baseProps} />)
    expect(screen.getByText(/sess_abc123/)).toBeTruthy()
    expect(screen.getByText(/a1b2c3d4/)).toBeTruthy()
  })

  it('renders a relative last-seen timestamp', () => {
    render(<MachineRow {...baseProps} />)
    expect(screen.getByText(/5m ago|6m ago/)).toBeTruthy()
  })

  it('calls onRevoke with the session id when the button is clicked', () => {
    const onRevoke = vi.fn()
    render(<MachineRow {...baseProps} onRevoke={onRevoke} />)
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    expect(onRevoke).toHaveBeenCalledWith({ sessionId: baseProps.clerkSessionId })
  })

  it('disables the revoke button when pending', () => {
    render(<MachineRow {...baseProps} pending={true} />)
    const button = screen.getByRole('button', { name: /revok/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders "—" for an unknown IP hash', () => {
    render(<MachineRow {...baseProps} lastIpHash={undefined} />)
    expect(screen.getByText('—')).toBeTruthy()
  })
})
