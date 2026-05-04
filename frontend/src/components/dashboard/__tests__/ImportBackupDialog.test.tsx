/**
 * Tests for ImportBackupDialog: Zod-validated passphrase via
 * react-hook-form. Verifies file-picker validation, inline passphrase
 * length error, and submit-disabled gating.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ImportBackupDialog } from '../ImportBackupDialog'

const importFn = vi.fn()

vi.mock('convex/react', () => ({
  useAction: () => importFn,
}))

beforeEach(() => {
  importFn.mockReset()
  importFn.mockResolvedValue({ restoredCount: 1, skippedCount: 0, errors: [] })
})

describe('ImportBackupDialog', () => {
  it('renders without crashing', () => {
    render(<ImportBackupDialog open={true} onOpenChange={vi.fn()} />)
    expect(screen.getByText(/Import encrypted backup/i)).toBeTruthy()
    expect(screen.getByPlaceholderText(/passphrase/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /restore/i })).toBeTruthy()
  })

  it('disables submit when passphrase is empty', () => {
    render(<ImportBackupDialog open={true} onOpenChange={vi.fn()} />)
    const submit = screen.getByRole('button', { name: /restore/i })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables submit and shows length error when passphrase < 12 chars', async () => {
    render(<ImportBackupDialog open={true} onOpenChange={vi.fn()} />)
    const passphraseInput = screen.getByPlaceholderText(/passphrase/i)
    fireEvent.change(passphraseInput, { target: { value: 'short' } })
    await waitFor(() => {
      expect(screen.getByText(/at least 12 characters/i)).toBeTruthy()
    })
    const submit = screen.getByRole('button', { name: /restore/i })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    expect(importFn).not.toHaveBeenCalled()
  })

  it('shows "Pick a .cvb backup file first." when valid passphrase provided but no file', async () => {
    render(<ImportBackupDialog open={true} onOpenChange={vi.fn()} />)
    const passphraseInput = screen.getByPlaceholderText(/passphrase/i)
    fireEvent.change(passphraseInput, { target: { value: 'correcthorsebatterystaple' } })
    const submit = screen.getByRole('button', { name: /restore/i })
    await waitFor(() => {
      expect((submit as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(submit)
    await waitFor(() => {
      expect(screen.getByText(/Pick a .cvb backup file first/i)).toBeTruthy()
    })
  })

  it('calls importEncryptedBackup with passphrase + bundleBase64 when both inputs valid', async () => {
    render(<ImportBackupDialog open={true} onOpenChange={vi.fn()} />)
    const passphraseInput = screen.getByPlaceholderText(/passphrase/i)
    fireEvent.change(passphraseInput, { target: { value: 'correcthorsebatterystaple' } })

    const fileInput = document.querySelector('input[type="file"]')
    if (!(fileInput instanceof HTMLInputElement)) throw new Error('file input not found')
    const file = new File(['dummy-cvb-bytes'], 'backup.cvb', { type: 'application/octet-stream' })
    // jsdom + RTL: assigning .files via DataTransfer is the canonical way.
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fireEvent.change(fileInput)

    const submit = screen.getByRole('button', { name: /restore/i })
    await waitFor(() => {
      expect((submit as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(submit)
    await waitFor(() => {
      expect(importFn).toHaveBeenCalled()
    })
    const call = importFn.mock.calls[0]?.[0] as { passphrase: string; bundleBase64: string } | undefined
    expect(call?.passphrase).toBe('correcthorsebatterystaple')
    expect(typeof call?.bundleBase64).toBe('string')
  })
})
