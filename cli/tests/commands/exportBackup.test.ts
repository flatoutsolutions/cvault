/**
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §7.
 *
 * `cvault export <out.cvb>` — passphrase-encrypted backup of every sub.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { runExportBackup } from '../../src/commands/exportBackup'

describe('runExportBackup', () => {
  it('writes the bundle to disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cvault-test-'))
    const out = join(dir, 'backup.cvb')

    const action = vi.fn().mockResolvedValueOnce({
      filename: 'cvault-backup-2026-05-04.cvb',
      contentBase64: Buffer.from('{"hello":"world"}', 'utf8').toString('base64'),
      accountCount: 1,
    })
    const client = {
      action,
      query: vi.fn(),
      withMachineLabel: <A extends object>(a: A) => a,
    }
    await runExportBackup({
      out,
      passphrase: 'correcthorsebatterystaple',
      makeClient: async () => client as unknown as never,
      log: () => {},
    })
    const written = readFileSync(out, 'utf8')
    expect(written).toBe('{"hello":"world"}')
    expect(action).toHaveBeenCalled()
  })

  it('throws on passphrase < 12 chars (client-side fast-fail)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cvault-test-'))
    const out = join(dir, 'b.cvb')
    const action = vi.fn()
    const client = {
      action,
      query: vi.fn(),
      withMachineLabel: <A extends object>(a: A) => a,
    }
    await expect(
      runExportBackup({
        out,
        passphrase: 'short',
        makeClient: async () => client as unknown as never,
        log: () => {},
      })
    ).rejects.toThrow(/12 characters/)
    expect(action).not.toHaveBeenCalled()
  })
})
