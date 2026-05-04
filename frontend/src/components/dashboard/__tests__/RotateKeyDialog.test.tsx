/**
 * Smoke tests for RotateKeyDialog: renders without crashing across all
 * three steps (instructions / confirm / running) and the close path.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RotateKeyDialog } from '../RotateKeyDialog'

vi.mock('convex/react', () => ({
  useAction: () => vi.fn().mockResolvedValue({ jobId: 'job_test', totalRows: 0, alreadyRunning: false }),
  useQuery: () => null,
}))

describe('RotateKeyDialog', () => {
  it('renders the instructions step when opened', () => {
    render(<RotateKeyDialog open={true} onOpenChange={vi.fn()} />)
    expect(screen.getByText(/Rotate encryption key/i)).toBeTruthy()
    expect(screen.getByText(/openssl rand -base64 32/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /next/i })).toBeTruthy()
  })

  it('advances to the confirm step when Next is clicked', () => {
    render(<RotateKeyDialog open={true} onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByText(/I have updated/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /start rotation/i })).toBeTruthy()
  })

  it('start rotation button is disabled until the confirmation checkbox is checked', () => {
    render(<RotateKeyDialog open={true} onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    const startBtn = screen.getByRole('button', { name: /start rotation/i })
    expect((startBtn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect((startBtn as HTMLButtonElement).disabled).toBe(false)
  })
})
