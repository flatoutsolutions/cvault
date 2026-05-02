/**
 * Linux/WSL plaintext credentials file at `<config_home>/.credentials.json`.
 *
 * Atomic writes (write to `<path>.<pid>.tmp`, rename), mode 0600 on the
 * final file. Mirrors `claude-swap`'s `_write_credentials` for Linux/WSL.
 *
 * Tests use a tmpdir + `vi.stubEnv('HOME', tempHome)` so we never touch
 * the real `~/.claude/.credentials.json`. Mode assertions are skipped on
 * win32 (where chmod is a partial no-op anyway) — Windows is unsupported
 * in v1, so it shouldn't reach this module on a real install.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteCredentialsFile, readCredentialsFile, writeCredentialsFile } from '../../src/native/credentialsFile'

let tempHome: string

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-credfile-test-'))
  vi.stubEnv('HOME', tempHome)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
})

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('readCredentialsFile', () => {
  it('returns null when the file does not exist', () => {
    expect(readCredentialsFile()).toBeNull()
  })

  it('returns file contents when the file exists', () => {
    const dir = join(tempHome, '.claude')
    mkdirSync(dir, { recursive: true })
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-A' } })
    writeFileSync(join(dir, '.credentials.json'), blob, { mode: 0o600 })
    expect(readCredentialsFile()).toBe(blob)
  })
})

describe('writeCredentialsFile', () => {
  it('creates the parent directory if missing and writes the blob', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'X' } })
    writeCredentialsFile(blob)
    const finalPath = join(tempHome, '.claude', '.credentials.json')
    expect(existsSync(finalPath)).toBe(true)
    expect(readFileSync(finalPath, 'utf8')).toBe(blob)
  })

  it('writes with mode 0600 on POSIX', () => {
    if (process.platform === 'win32') return
    writeCredentialsFile('{}')
    const finalPath = join(tempHome, '.claude', '.credentials.json')
    const mode = statSync(finalPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('overwrites an existing file (atomic via temp + rename)', () => {
    const dir = join(tempHome, '.claude')
    mkdirSync(dir, { recursive: true })
    const finalPath = join(dir, '.credentials.json')
    writeFileSync(finalPath, 'OLD', { mode: 0o600 })

    writeCredentialsFile('NEW')

    expect(readFileSync(finalPath, 'utf8')).toBe('NEW')
    // No temp leftovers.
    const tempLeftovers = readdirSync(dir).filter((n) => n.includes('.tmp'))
    expect(tempLeftovers).toEqual([])
  })

  it('respects CLAUDE_CONFIG_DIR', () => {
    const customDir = join(tempHome, 'my-config')
    vi.stubEnv('CLAUDE_CONFIG_DIR', customDir)
    writeCredentialsFile('{}')
    expect(existsSync(join(customDir, '.credentials.json'))).toBe(true)
  })
})

describe('deleteCredentialsFile', () => {
  it('removes the file when present', () => {
    const dir = join(tempHome, '.claude')
    mkdirSync(dir, { recursive: true })
    const finalPath = join(dir, '.credentials.json')
    writeFileSync(finalPath, '{}', { mode: 0o600 })

    deleteCredentialsFile()
    expect(existsSync(finalPath)).toBe(false)
  })

  it('is a no-op when the file is already absent', () => {
    expect(() => deleteCredentialsFile()).not.toThrow()
  })
})
