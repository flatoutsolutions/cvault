/**
 * Tests for the persistent machine-id helper (cli/src/auth/machineId.ts).
 *
 * Each test gets a fresh tmp HOME so writes never touch ~/.vault on the
 * host machine.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadOrCreateMachineId } from '../../src/auth/machineId'

afterEach(() => vi.unstubAllEnvs())

describe('loadOrCreateMachineId', () => {
  it('generates once and is stable across calls', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vault-'))
    vi.stubEnv('HOME', home)
    const a = await loadOrCreateMachineId()
    const b = await loadOrCreateMachineId()
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).toBe(b)
  })
})
