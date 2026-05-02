/**
 * Read/write the `oauthAccount` slice of `~/.claude.json`.
 *
 * Claude Code persists per-user metadata (email, accountUuid,
 * organizationUuid, etc.) in this file alongside other keys it owns
 * (caches, feature flags, telemetry IDs). cvault MUST NOT clobber the
 * other keys — only the `oauthAccount` slice gets read and written.
 *
 * Atomic write pattern (mirrors claude-swap's transfer.py:_atomic_write_file):
 *   1. Read existing JSON (or `{}` if missing)
 *   2. Merge in the new `oauthAccount`
 *   3. Write to `<path>.<pid>.tmp`
 *   4. JSON.parse roundtrip on the tmp content (catches malformed writes)
 *   5. rename tmp over `<path>`
 *   6. chmod 0600
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearOauthAccount, readGlobalConfig, writeOauthAccount } from '../../src/native/claudeConfig'

let tempHome: string
let configPath: string

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-claudecfg-test-'))
  vi.stubEnv('HOME', tempHome)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  configPath = join(tempHome, '.claude.json')
})

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('readGlobalConfig', () => {
  it('returns null when the file does not exist', () => {
    expect(readGlobalConfig()).toBeNull()
  })

  it('parses and returns the JSON object', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        oauthAccount: { emailAddress: 'a@b.com', accountUuid: 'u-1' },
        somethingElse: { keep: true },
      }),
      { mode: 0o600 }
    )
    const cfg = readGlobalConfig()
    expect(cfg).toEqual({
      oauthAccount: { emailAddress: 'a@b.com', accountUuid: 'u-1' },
      somethingElse: { keep: true },
    })
  })

  it('throws on malformed JSON', () => {
    writeFileSync(configPath, '{not-valid-json', { mode: 0o600 })
    expect(() => readGlobalConfig()).toThrow(/JSON|parse/i)
  })
})

describe('writeOauthAccount', () => {
  it('creates the file when missing, with mode 0600', () => {
    writeOauthAccount({
      emailAddress: 'new@user.com',
      accountUuid: 'u-1',
      organizationUuid: 'o-1',
      organizationName: 'Acme',
    })

    expect(existsSync(configPath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as { oauthAccount: Record<string, unknown> }
    expect(onDisk.oauthAccount).toEqual({
      emailAddress: 'new@user.com',
      accountUuid: 'u-1',
      organizationUuid: 'o-1',
      organizationName: 'Acme',
    })

    if (process.platform !== 'win32') {
      const mode = statSync(configPath).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('preserves existing non-oauthAccount keys when merging', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        oauthAccount: { emailAddress: 'old@x.com' },
        cachedTelemetryId: 'tel-1',
        featureFlags: { foo: true },
      }),
      { mode: 0o600 }
    )

    writeOauthAccount({ emailAddress: 'new@x.com', accountUuid: 'u-2' })

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect((onDisk.oauthAccount as { emailAddress: string }).emailAddress).toBe('new@x.com')
    // CRITICAL — cvault must NOT clobber sibling keys.
    expect(onDisk.cachedTelemetryId).toBe('tel-1')
    expect(onDisk.featureFlags).toEqual({ foo: true })
  })

  it('uses an atomic temp+rename so a crashed mid-write leaves no partial', () => {
    // Sanity check: after the write completes, no `<path>.<pid>.tmp` lingers.
    writeOauthAccount({ emailAddress: 'a@b.com' })
    const tmpLeftovers = readdirSync(tempHome).filter((n) => n.includes('.tmp'))
    expect(tmpLeftovers).toEqual([])
  })

  it('rejects when the merge would not roundtrip through JSON', () => {
    // BigInt cannot be JSON-stringified. Ensure the wrapper detects this
    // BEFORE renaming over the existing file.
    writeFileSync(configPath, JSON.stringify({ oauthAccount: { emailAddress: 'old@x.com' } }), { mode: 0o600 })
    expect(() => writeOauthAccount({ badField: 1n as unknown as string })).toThrow()
    // Original content must still be intact.
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as { oauthAccount: { emailAddress: string } }
    expect(onDisk.oauthAccount.emailAddress).toBe('old@x.com')
  })
})

describe('clearOauthAccount', () => {
  it('removes only the oauthAccount key, preserving siblings', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        oauthAccount: { emailAddress: 'a@b.com' },
        somethingElse: { keep: true },
      }),
      { mode: 0o600 }
    )

    clearOauthAccount()
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    expect(onDisk.oauthAccount).toBeUndefined()
    expect(onDisk.somethingElse).toEqual({ keep: true })
  })

  it('is a no-op when the file does not exist', () => {
    expect(() => clearOauthAccount()).not.toThrow()
    expect(existsSync(configPath)).toBe(false)
  })

  it('handles a file with no oauthAccount key gracefully', () => {
    writeFileSync(configPath, JSON.stringify({ otherKey: 1 }), { mode: 0o600 })
    expect(() => clearOauthAccount()).not.toThrow()
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as { otherKey: number }
    expect(onDisk.otherKey).toBe(1)
  })
})
