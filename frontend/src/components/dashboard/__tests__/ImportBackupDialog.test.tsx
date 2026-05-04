/**
 * Smoke test for ImportBackupDialog: renders the file picker +
 * passphrase input + Restore button without crashing.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ImportBackupDialog } from '../ImportBackupDialog'

vi.mock('convex/react', () => ({
  useAction: () => vi.fn().mockResolvedValue({ restoredCount: 1, skippedCount: 0, errors: [] }),
}))

describe('ImportBackupDialog', () => {
  it('renders without crashing', () => {
    render(<ImportBackupDialog open={true} onOpenChange={vi.fn()} />)
    expect(screen.getByText(/Import encrypted backup/i)).toBeTruthy()
    expect(screen.getByPlaceholderText(/passphrase/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /restore/i })).toBeTruthy()
  })

  it('shows "Pick a .cvb backup file first." when Restore is clicked without a file', async () => {
    render(<ImportBackupDialog open={true} onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /restore/i }))
    await waitFor(() => {
      expect(screen.getByText(/Pick a .cvb backup file first/i)).toBeTruthy()
    })
  })
})
