/**
 * Tests for ExportBackupDialog: Zod-validated passphrase form via
 * react-hook-form. Verifies inline error display, submit-disabled gating,
 * and that the export action is invoked only when the form is valid.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ExportBackupDialog } from '../ExportBackupDialog'

const exportFn = vi.fn()

vi.mock('convex/react', () => ({
  useAction: () => exportFn,
}))

beforeEach(() => {
  exportFn.mockReset()
  exportFn.mockResolvedValue({
    filename: 'cvault-backup-2026-05-04.cvb',
    contentBase64: btoa('hello'),
    accountCount: 1,
  })
})

describe('ExportBackupDialog', () => {
  it('renders without crashing', () => {
    render(<ExportBackupDialog open={true} onOpenChange={vi.fn()} />)
    expect(screen.getByText(/Export encrypted backup/i)).toBeTruthy()
  })

  it('disables submit and shows length error when passphrase < 12 chars', async () => {
    render(<ExportBackupDialog open={true} onOpenChange={vi.fn()} />)
    const inputs = screen.getAllByPlaceholderText(/passphrase/i)
    fireEvent.change(inputs[0], { target: { value: 'short' } })
    fireEvent.change(inputs[1], { target: { value: 'short' } })
    // Inline error visible after onChange validation.
    await waitFor(() => {
      expect(screen.getByText(/at least 12 characters/i)).toBeTruthy()
    })
    const submit = screen.getByRole('button', { name: /export backup/i })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    // Action must not have been invoked.
    expect(exportFn).not.toHaveBeenCalled()
  })

  it('disables submit and shows mismatch error when confirm differs', async () => {
    render(<ExportBackupDialog open={true} onOpenChange={vi.fn()} />)
    const inputs = screen.getAllByPlaceholderText(/passphrase/i)
    fireEvent.change(inputs[0], { target: { value: 'correcthorsebatterystaple' } })
    fireEvent.change(inputs[1], { target: { value: 'wronghorsebatterystaple12' } })
    await waitFor(() => {
      expect(screen.getByText(/do not match/i)).toBeTruthy()
    })
    const submit = screen.getByRole('button', { name: /export backup/i })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    expect(exportFn).not.toHaveBeenCalled()
  })

  it('enables submit and calls exportEncryptedBackup with the passphrase when valid', async () => {
    // jsdom doesn't implement URL.createObjectURL; stub for the Blob
    // download path the dialog runs after a successful export.
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })

    render(<ExportBackupDialog open={true} onOpenChange={vi.fn()} />)
    const inputs = screen.getAllByPlaceholderText(/passphrase/i)
    fireEvent.change(inputs[0], { target: { value: 'correcthorsebatterystaple' } })
    fireEvent.change(inputs[1], { target: { value: 'correcthorsebatterystaple' } })

    const submit = screen.getByRole('button', { name: /export backup/i })
    await waitFor(() => {
      expect((submit as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(submit)
    await waitFor(() => {
      expect(exportFn).toHaveBeenCalledWith({ passphrase: 'correcthorsebatterystaple' })
    })
  })
})
