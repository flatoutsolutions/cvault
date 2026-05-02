/**
 * Spec: §7 — `cvault clean`.
 *
 * Wipes local Keychain (via `claude-swap --remove-account`) and the
 * `~/.vault/last-hash-*.txt` cache. Preserves `~/.vault/session.json`
 * (the CLI stays signed in) and the Convex-side vault.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClaudeSwapMissingError, purge } from '../../src/claudeSwap'
import { runClean } from '../../src/commands/clean'

vi.mock('../../src/claudeSwap', async () => {
  const actual = await vi.importActual<typeof import('../../src/claudeSwap')>('../../src/claudeSwap')
  return {
    ...actual,
    purge: vi.fn(),
  }
})

let tempHome: string
let originalHome: string | undefined

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-clean-test-'))
  originalHome = process.env.HOME
  vi.stubEnv('HOME', tempHome)
  vi.mocked(purge).mockReset()
})

afterEach(() => {
  if (originalHome !== undefined) {
    vi.stubEnv('HOME', originalHome)
  }
  rmSync(tempHome, { recursive: true, force: true })
})

/**
 * Build minimal stdin/stdout streams so we can exercise the y/N prompt
 * without touching the real TTY.
 */
function fakeIo(answer: string): {
  input: Readable
  output: Writable
  written: string[]
} {
  const written: string[] = []
  const input = Readable.from([`${answer}\n`])
  const output = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      cb()
    },
  })
  return { input, output, written }
}

describe('runClean', () => {
  it('purges every claude-swap account and the last-hash files when confirmed', async () => {
    vi.mocked(purge).mockImplementationOnce(() => undefined)
    // Seed hash files (and one unrelated file we should NOT touch).
    const vaultPath = join(tempHome, '.vault')
    mkdirSync(vaultPath, { recursive: true })
    writeFileSync(join(vaultPath, 'last-hash-a@b.com.txt'), 'h1')
    writeFileSync(join(vaultPath, 'last-hash-c@d.com.txt'), 'h2')
    writeFileSync(join(vaultPath, 'session.json'), '{"keep":true}')

    const io = fakeIo('y')
    const summary = await runClean({ io })

    expect(purge).toHaveBeenCalledOnce()
    expect(summary).toEqual({
      keychainPurged: true,
      hashFilesRemoved: 2,
      hashFilesFailed: 0,
    })

    // session.json must survive; hash files must be gone.
    const remaining = readdirSync(vaultPath).sort()
    expect(remaining).toEqual(['session.json'])
  })

  it('aborts on a "no" answer without touching anything', async () => {
    const vaultPath = join(tempHome, '.vault')
    mkdirSync(vaultPath, { recursive: true })
    writeFileSync(join(vaultPath, 'last-hash-a@b.com.txt'), 'h1')

    const io = fakeIo('n')
    const summary = await runClean({ io })

    expect(purge).not.toHaveBeenCalled()
    expect(summary.keychainPurged).toBe(false)
    expect(summary.hashFilesRemoved).toBe(0)
    // Hash file must still be present.
    expect(readdirSync(vaultPath)).toContain('last-hash-a@b.com.txt')
  })

  it('skips the prompt with `yes: true`', async () => {
    vi.mocked(purge).mockImplementationOnce(() => undefined)

    const summary = await runClean({ yes: true })

    expect(purge).toHaveBeenCalledOnce()
    expect(summary.keychainPurged).toBe(true)
  })

  it('continues when claude-swap is missing — still clears hash files', async () => {
    vi.mocked(purge).mockImplementationOnce(() => {
      throw new ClaudeSwapMissingError()
    })
    const vaultPath = join(tempHome, '.vault')
    mkdirSync(vaultPath, { recursive: true })
    writeFileSync(join(vaultPath, 'last-hash-a@b.com.txt'), 'h1')

    const summary = await runClean({ yes: true })

    expect(summary.keychainPurged).toBe(false)
    expect(summary.hashFilesRemoved).toBe(1)
  })

  it('reports keychainPurged=false when claude-swap --purge errors', async () => {
    vi.mocked(purge).mockImplementationOnce(() => {
      throw new Error('keychain locked')
    })

    const summary = await runClean({ yes: true })

    expect(summary.keychainPurged).toBe(false)
  })
})
