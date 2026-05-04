/**
 * Smoke tests for ExportBackupDialog: renders without crashing,
 * surfaces validation errors, calls the export action when valid input
 * is supplied.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ExportBackupDialog } from '../ExportBackupDialog'

const exportFn = vi.fn().mockResolvedValue({
  filename: 'cvault-backup-2026-05-04.cvb',
  contentBase64: btoa('hello'),
  accountCount: 1,
})

vi.mock('convex/react', () => ({
  useAction: () => exportFn,
}))

describe('ExportBackupDialog', () => {
  it('renders without crashing', () => {
    render(<ExportBackupDialog open={true} onOpenChange={vi.fn()} />)
    expect(screen.getByText(/Export encrypted backup/i)).toBeTruthy()
  })

  it('surfaces "Passphrase must be at least 12 characters" on short input', async () => {
    render(<ExportBackupDialog open={true} onOpenChange={vi.fn()} />)
    const inputs = screen.getAllByPlaceholderText(/passphrase/i)
    fireEvent.change(inputs[0], { target: { value: 'short' } })
    fireEvent.change(inputs[1], { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: /export backup/i }))
    await waitFor(() => {
      expect(screen.getByText(/at least 12 characters/i)).toBeTruthy()
    })
  })

  it('surfaces "Passphrases do not match" when confirm differs', async () => {
    render(<ExportBackupDialog open={true} onOpenChange={vi.fn()} />)
    const inputs = screen.getAllByPlaceholderText(/passphrase/i)
    fireEvent.change(inputs[0], { target: { value: 'correcthorsebatterystaple' } })
    fireEvent.change(inputs[1], { target: { value: 'wronghorsebatterystaple12' } })
    fireEvent.click(screen.getByRole('button', { name: /export backup/i }))
    await waitFor(() => {
      expect(screen.getByText(/do not match/i)).toBeTruthy()
    })
  })
})
