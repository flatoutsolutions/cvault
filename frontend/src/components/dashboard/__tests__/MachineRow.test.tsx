/**
 * MachineRow — single row in /dashboard/machines.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Each row represents a Clerk session that has used the vault
 * (so we get the session id from `machineActivity.distinctSessionsForUser`).
 *
 * The "Revoke" button calls the parent-supplied `onRevoke({sessionId})`
 * callback; the parent page wires it to `api.cli.actions.revokeSession`.
 *
 * Contract under test:
 * - Renders the human-readable `machineLabel` as the primary text
 * - Falls back to a "(no label)" placeholder when `machineLabel` is undefined
 * - Renders a stacked secondary line: "Last seen Nm ago" + optional "IP: <prefix>"
 * - Hides the "IP" fragment when `lastIpHash` is undefined
 * - Exposes the full `clerkSessionId` via the row's native title attribute
 *   (debug-only — the visible label is the user-facing identifier)
 * - Renders a "Revoke" button that calls onRevoke({sessionId: clerkSessionId})
 *   regardless of label state — backend revoke is keyed by sessionId
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
    machineLabel: 'saads-macbook-pro',
    revocable: true,
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
    // No "IP:" anywhere on the row
    expect(screen.queryByText(/IP:/)).toBeNull()
  })

  it('exposes the full clerkSessionId via the row title attribute for debugging', () => {
    const { container } = render(<MachineRow {...baseProps} />)
    const row = container.querySelector('[data-slot="machine-row"]')
    expect(row).toBeTruthy()
    expect(row?.getAttribute('title')).toBe(baseProps.clerkSessionId)
  })

  it('calls onRevoke with the clerkSessionId when the button is clicked', () => {
    const onRevoke = vi.fn()
    render(<MachineRow {...baseProps} onRevoke={onRevoke} />)
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    expect(onRevoke).toHaveBeenCalledWith({ sessionId: baseProps.clerkSessionId })
  })

  it('still calls onRevoke with the clerkSessionId even when label is missing', () => {
    const onRevoke = vi.fn()
    render(<MachineRow {...baseProps} machineLabel={undefined} onRevoke={onRevoke} />)
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    expect(onRevoke).toHaveBeenCalledWith({ sessionId: baseProps.clerkSessionId })
  })

  it('disables the revoke button when pending', () => {
    render(<MachineRow {...baseProps} pending={true} />)
    const button = screen.getByRole('button', { name: /revok/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables the revoke button when revocable is false and shows server-side hint', () => {
    render(<MachineRow {...baseProps} revocable={false} />)
    const button = screen.getByRole('button', { name: /revok/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/server-side/)).toBeTruthy()
  })

  it('renders "Server-side activity" as the primary label when revocable is false and label is missing', () => {
    // This distinguishes "no live Clerk session" rows (cron, server
    // context, pre-fix CLI) from "real machine that pre-dates the label
    // feature" — the latter still shows "(no label)" so users see they
    // could have set a label but didn't.
    render(<MachineRow {...baseProps} machineLabel={undefined} revocable={false} />)
    expect(screen.getByText('Server-side activity')).toBeTruthy()
    // The italic placeholder text MUST NOT appear — that's the
    // "revocable but unlabeled" affordance.
    expect(screen.queryByText('(no label)')).toBeNull()
  })

  it('keeps the user-supplied label as primary text even when revocable is false', () => {
    // When the sentinel-tagged row DOES have a label (older CLI wrote
    // one before we knew it was sentinel-bound), preserve it — it's
    // more identifiable than a generic "Server-side activity".
    render(<MachineRow {...baseProps} machineLabel="batch-runner-01" revocable={false} />)
    expect(screen.getByText('batch-runner-01')).toBeTruthy()
    expect(screen.queryByText('Server-side activity')).toBeNull()
  })
})
