/**
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §7.
 *
 * `cvault import <in.cvb>` — restore from a passphrase-encrypted bundle.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { runImportBackup } from '../../src/commands/importBackup'

describe('runImportBackup', () => {
  it('reads the bundle and calls importEncryptedBackup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cvault-import-'))
    const file = join(dir, 'b.cvb')
    const fakeBundle = Buffer.from('{"version":1}', 'utf8')
    writeFileSync(file, fakeBundle)

    const action = vi.fn().mockResolvedValueOnce({ restoredCount: 2, skippedCount: 0, errors: [] })
    const client = {
      action,
      query: vi.fn(),
      withMachineLabel: <A extends object>(a: A) => a,
    }
    await runImportBackup({
      in: file,
      passphrase: 'correcthorsebatterystaple',
      makeClient: async () => client as unknown as never,
      log: () => {},
    })
    expect(action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ passphrase: 'correcthorsebatterystaple' })
    )
  })

  it('logs restored / skipped counts plus per-account errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cvault-import-'))
    const file = join(dir, 'b.cvb')
    writeFileSync(file, Buffer.from('{}', 'utf8'))

    const action = vi.fn().mockResolvedValueOnce({
      restoredCount: 1,
      skippedCount: 1,
      errors: ['x@example.com: bad'],
    })
    const client = {
      action,
      query: vi.fn(),
      withMachineLabel: <A extends object>(a: A) => a,
    }
    const logs: string[] = []
    await runImportBackup({
      in: file,
      passphrase: 'correcthorsebatterystaple',
      makeClient: async () => client as unknown as never,
      log: (m) => logs.push(m),
    })
    const out = logs.join('\n')
    expect(out).toMatch(/Restored 1/)
    expect(out).toMatch(/skipped 1/)
    expect(out).toMatch(/x@example.com: bad/)
  })
})
