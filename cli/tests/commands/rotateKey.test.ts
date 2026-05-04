/**
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §7.
 *
 * `cvault rotate-key` — generates a fresh AES-256 master key, prints
 * the env-var commands the operator must run, then triggers the
 * server-side rotation against the caller's own subs.
 */
import { describe, expect, it, vi } from 'vitest'

import { runRotateKey } from '../../src/commands/rotateKey'

describe('runRotateKey', () => {
  it('prints a generated key + env-var commands and triggers rotation', async () => {
    const action = vi.fn().mockResolvedValueOnce({
      jobId: 'job_test_xyz',
      totalRows: 3,
      alreadyRunning: false,
    })
    const query = vi.fn().mockResolvedValueOnce({
      _id: 'job_test_xyz',
      status: 'completed',
      processedRows: 3,
      totalRows: 3,
      errorCount: 0,
      toVersion: 'v2',
      startedAt: Date.now(),
    })
    const client = {
      action,
      query,
      withMachineLabel: <A extends object>(a: A) => a,
    }
    const logs: string[] = []
    await runRotateKey({
      makeClient: async () => client as unknown as never,
      log: (m) => logs.push(m),
      pollIntervalMs: 0,
      autoConfirm: true,
    })
    const out = logs.join('\n')
    // Generated key surfaced
    expect(out).toMatch(/Generated new AES-256 master key/i)
    expect(out).toMatch(/NEW_KEY=/)
    // Env-var commands surfaced
    expect(out).toMatch(/VAULT_AES_KEY_PREVIOUS/)
    expect(out).toMatch(/VAULT_AES_KEY/)
    expect(out).toMatch(/VAULT_KEY_VERSION/)
    // Rotation actually triggered
    expect(action).toHaveBeenCalled()
    // Completion line
    expect(out).toMatch(/Rotation complete/)
  })

  it('reports alreadyRunning when the server says a job is in flight', async () => {
    const action = vi.fn().mockResolvedValueOnce({
      jobId: 'job_running',
      totalRows: 5,
      alreadyRunning: true,
    })
    const query = vi.fn().mockResolvedValueOnce({
      _id: 'job_running',
      status: 'running',
      processedRows: 2,
      totalRows: 5,
      errorCount: 0,
      toVersion: 'v2',
      startedAt: Date.now(),
    })
    const client = {
      action,
      query,
      withMachineLabel: <A extends object>(a: A) => a,
    }
    const logs: string[] = []
    await runRotateKey({
      makeClient: async () => client as unknown as never,
      log: (m) => logs.push(m),
      pollIntervalMs: 0,
      autoConfirm: true,
    })
    const out = logs.join('\n')
    expect(out).toMatch(/already in flight|already running/i)
  })
})
