/**
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §7.
 *
 * `cvault rotate-key` — generates a fresh AES-256 master key, prints
 * the env-var commands the operator must run, then triggers the
 * server-side rotation against the caller's own subs.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runRotateKey } from '../../src/commands/rotateKey'

let tempHome: string

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-rotate-key-test-'))
  vi.stubEnv('HOME', tempHome)
})

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

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
      
      withMeta: <A extends object>(a: A) => ({ ...a, machineId: 'fake-machine-id' }),
    }
    const logs: string[] = []
    await runRotateKey({
      makeClient: async () => client as unknown as never,
      log: (m) => logs.push(m),
      pollIntervalMs: 0,
      autoConfirm: true,
    })
    const out = logs.join('\n')
    // Header surfaced
    expect(out).toMatch(/Generated new AES-256 master key/i)
    // Env-var commands surfaced — but with NO inlined raw key value.
    expect(out).toMatch(/VAULT_AES_KEY_PREVIOUS/)
    expect(out).toMatch(/VAULT_AES_KEY/)
    expect(out).toMatch(/VAULT_KEY_VERSION/)
    // The path to the file holding the new key surfaces.
    expect(out).toMatch(/new-key\.txt/)
    // The fingerprint (16 hex chars) surfaces; the raw key MUST NOT.
    expect(out).toMatch(/fingerprint:?\s*[0-9a-f]{16}/i)
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
      
      withMeta: <A extends object>(a: A) => ({ ...a, machineId: 'fake-machine-id' }),
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

  // SECURITY: the prior implementation printed the raw base64-encoded
  // master AES key to stdout via `log()` lines (`NEW_KEY=<key>` and
  // `VAULT_AES_KEY="<key>"`). Anything stdout-bound is captured by
  // shell history, terminal scrollback, and CI logs — so the master
  // key would persist in places we can't reach to scrub. The fix:
  // write the key to a file under ~/.vault/ at mode 0600 and print
  // only the path + a 16-hex-char fingerprint so the user can verify
  // the file's contents without the raw key ever touching stdout.
  it('SECURITY: never prints the raw master key to stdout', async () => {
    const action = vi.fn().mockResolvedValueOnce({
      jobId: 'job_safety',
      totalRows: 1,
      alreadyRunning: false,
    })
    const query = vi.fn().mockResolvedValueOnce({
      _id: 'job_safety',
      status: 'completed',
      processedRows: 1,
      totalRows: 1,
      errorCount: 0,
      toVersion: 'v2',
      startedAt: Date.now(),
    })
    const client = {
      action,
      query,
      withMachineLabel: <A extends object>(a: A) => a,
      
      withMeta: <A extends object>(a: A) => ({ ...a, machineId: 'fake-machine-id' }),
    }
    const logs: string[] = []
    await runRotateKey({
      makeClient: async () => client as unknown as never,
      log: (m) => logs.push(m),
      pollIntervalMs: 0,
      autoConfirm: true,
    })

    // Read the actual key the command wrote to disk.
    const keyFilePath = join(tempHome, '.vault', 'new-key.txt')
    const fileContents = readFileSync(keyFilePath, 'utf8')
    expect(fileContents.length).toBeGreaterThan(0)

    // Stdout MUST NOT contain the literal key value anywhere — not after
    // `NEW_KEY=`, not inside the env-var command, not anywhere.
    const out = logs.join('\n')
    expect(out).not.toContain(fileContents)
  })

  it('SECURITY: writes the new key to ~/.vault/new-key.txt with mode 0600', async () => {
    const action = vi.fn().mockResolvedValueOnce({
      jobId: 'job_perm',
      totalRows: 1,
      alreadyRunning: false,
    })
    const query = vi.fn().mockResolvedValueOnce({
      _id: 'job_perm',
      status: 'completed',
      processedRows: 1,
      totalRows: 1,
      errorCount: 0,
      toVersion: 'v2',
      startedAt: Date.now(),
    })
    const client = {
      action,
      query,
      withMachineLabel: <A extends object>(a: A) => a,
      
      withMeta: <A extends object>(a: A) => ({ ...a, machineId: 'fake-machine-id' }),
    }
    await runRotateKey({
      makeClient: async () => client as unknown as never,
      log: () => undefined,
      pollIntervalMs: 0,
      autoConfirm: true,
    })

    const keyFilePath = join(tempHome, '.vault', 'new-key.txt')
    const stats = statSync(keyFilePath)
    // Owner-only read+write — group/other bits MUST be cleared.
    expect(stats.mode & 0o777).toBe(0o600)
    // The file should hold a real 32-byte base64-encoded key (44 chars
    // including the trailing `=` padding).
    const contents = readFileSync(keyFilePath, 'utf8')
    expect(contents.length).toBeGreaterThanOrEqual(43)
  })

  it('SECURITY: prints a fingerprint matching the on-disk key', async () => {
    const action = vi.fn().mockResolvedValueOnce({
      jobId: 'job_fp',
      totalRows: 1,
      alreadyRunning: false,
    })
    const query = vi.fn().mockResolvedValueOnce({
      _id: 'job_fp',
      status: 'completed',
      processedRows: 1,
      totalRows: 1,
      errorCount: 0,
      toVersion: 'v2',
      startedAt: Date.now(),
    })
    const client = {
      action,
      query,
      withMachineLabel: <A extends object>(a: A) => a,
      
      withMeta: <A extends object>(a: A) => ({ ...a, machineId: 'fake-machine-id' }),
    }
    const logs: string[] = []
    await runRotateKey({
      makeClient: async () => client as unknown as never,
      log: (m) => logs.push(m),
      pollIntervalMs: 0,
      autoConfirm: true,
    })

    const keyFilePath = join(tempHome, '.vault', 'new-key.txt')
    const contents = readFileSync(keyFilePath, 'utf8')
    const { createHash } = await import('node:crypto')
    const expectedFingerprint = createHash('sha256').update(contents).digest('hex').slice(0, 16)

    const out = logs.join('\n')
    expect(out).toContain(expectedFingerprint)
  })
})
