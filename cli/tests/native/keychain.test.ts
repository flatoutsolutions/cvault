/**
 * macOS Keychain reads/writes/deletes via the `security(1)` CLI.
 *
 * Service: "Claude Code-credentials" — pinned by Claude Code itself.
 * Account: $USER (fall back to "user").
 *
 * Critical exit codes:
 *  - 0    — success; stdout contains the JSON blob (read) or empty (write)
 *  - 44   — item not found; cvault treats as `null` from `read`
 *  - 36   — interaction-required (SSH / headless context)
 *  - 51   — ACL denied (legacy claude-swap entry)
 *  - 128  — user cancelled prompt
 *  - other — `NativeKeychainError` with redacted stderr
 *
 * The wrapper stubs `Bun.spawnSync` so tests never touch the real keychain.
 * Integration tests gated on `CVAULT_E2E_KEYCHAIN` exercise the real path
 * (see `tests/integration/keychainRoundtrip.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NativeKeychainError } from '../../src/native/errors'
import {
  KEYCHAIN_SERVICE,
  deleteActiveCredentials,
  readActiveCredentials,
  writeActiveCredentials,
} from '../../src/native/keychain'

interface SpawnCall {
  cmd: string[]
  stdin: string | undefined
}

interface FakeSyncResult {
  exitCode: number | null
  stdout: Uint8Array
  stderr: Uint8Array
}

interface SpawnOpts {
  cmd: string[]
  stdin?: unknown
}

/** Stub `Bun.spawnSync` so tests never exec `security`. */
function stubSpawnSync(
  impl: (call: SpawnCall) => FakeSyncResult | Error,
  calls: SpawnCall[] = []
): { calls: SpawnCall[]; restore: () => void } {
  const spy = vi.spyOn(Bun, 'spawnSync').mockImplementation(((opts: SpawnOpts) => {
    const stdin =
      typeof opts.stdin === 'string'
        ? opts.stdin
        : opts.stdin instanceof Buffer
          ? opts.stdin.toString('utf8')
          : opts.stdin instanceof Uint8Array
            ? new TextDecoder().decode(opts.stdin)
            : undefined
    const call: SpawnCall = { cmd: opts.cmd, stdin }
    calls.push(call)
    const out = impl(call)
    if (out instanceof Error) throw out
    return out
  }) as unknown as typeof Bun.spawnSync)
  return { calls, restore: () => spy.mockRestore() }
}

let originalPlatform: NodeJS.Platform

beforeEach(() => {
  // The keychain module's L4c platform guard throws on non-darwin. Most
  // tests in this file set the platform explicitly anyway, but darwin
  // is the right default for read/write/delete behavior tests.
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

describe('KEYCHAIN_SERVICE', () => {
  it('matches the service name Claude Code uses', () => {
    // Pinned by Claude Code; cvault must use the exact same service name to
    // read/write the credentials Claude Code's own runtime consumes.
    expect(KEYCHAIN_SERVICE).toBe('Claude Code-credentials')
  })
})

describe('readActiveCredentials', () => {
  it('returns the stdout blob on exit 0', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-A' } })
    const calls: SpawnCall[] = []
    stubSpawnSync(
      () => ({
        exitCode: 0,
        stdout: new TextEncoder().encode(blob),
        stderr: new Uint8Array(),
      }),
      calls
    )
    const out = readActiveCredentials()
    expect(out).toBe(blob)
    expect(calls[0]?.cmd[0]).toBe('security')
    expect(calls[0]?.cmd).toContain('find-generic-password')
    expect(calls[0]?.cmd).toContain('-w')
    expect(calls[0]?.cmd).toContain(KEYCHAIN_SERVICE)
  })

  it('strips a single trailing newline that `security` adds', () => {
    // `security -w` emits the blob followed by '\n'. cvault stores the raw
    // JSON without the trailing newline — strip it on read for a stable
    // round-trip.
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-B' } })
    stubSpawnSync(() => ({
      exitCode: 0,
      stdout: new TextEncoder().encode(`${blob}\n`),
      stderr: new Uint8Array(),
    }))
    expect(readActiveCredentials()).toBe(blob)
  })

  it('returns null when `security` exits 44 (not found)', () => {
    stubSpawnSync(() => ({
      exitCode: 44,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode(
        'SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'
      ),
    }))
    expect(readActiveCredentials()).toBeNull()
  })

  it('classifies exit 36 as interaction-required with an SSH/headless hint', () => {
    stubSpawnSync(() => ({
      exitCode: 36,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('User interaction is not allowed.'),
    }))
    try {
      readActiveCredentials()
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(NativeKeychainError)
      const e = err as NativeKeychainError
      expect(e.exitCode).toBe(36)
      expect(e.message).toMatch(/interaction-required/i)
      expect(e.message).toMatch(/Terminal|SSH|headless/i)
    }
  })

  it('classifies exit 51 as auth-denied (compat with legacy claude-swap entries)', () => {
    stubSpawnSync(() => ({
      exitCode: 51,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('Authorization denied'),
    }))
    expect(() => readActiveCredentials()).toThrow(/auth-denied/i)
  })

  it('classifies exit 128 as cancelled (user dismissed SecurityAgent prompt)', () => {
    stubSpawnSync(() => ({
      exitCode: 128,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('User cancelled'),
    }))
    expect(() => readActiveCredentials()).toThrow(/cancelled/i)
  })

  it('classifies a null exitCode (Bun timeout / signal kill) as interaction-required', () => {
    stubSpawnSync(() => ({
      exitCode: null,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    }))
    try {
      readActiveCredentials()
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(NativeKeychainError)
      expect((err as NativeKeychainError).message).toMatch(/interaction-required/i)
    }
  })

  it('throws NativeKeychainError on other (unknown) non-zero exit', () => {
    stubSpawnSync(() => ({
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('keychain locked'),
    }))
    try {
      readActiveCredentials()
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(NativeKeychainError)
      const e = err as NativeKeychainError
      expect(e.exitCode).toBe(1)
      expect(e.stderr).toContain('keychain locked')
    }
  })

  it('uses $USER for the account when set', () => {
    const calls: SpawnCall[] = []
    const origUser = process.env.USER
    try {
      process.env.USER = 'stefan'
      stubSpawnSync(() => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }), calls)
      readActiveCredentials()
      const aIdx = calls[0]?.cmd.indexOf('-a') ?? -1
      expect(aIdx).toBeGreaterThanOrEqual(0)
      expect(calls[0]?.cmd[aIdx + 1]).toBe('stefan')
    } finally {
      if (origUser === undefined) delete process.env.USER
      else process.env.USER = origUser
    }
  })

  it('falls back to "user" when $USER is unset', () => {
    const calls: SpawnCall[] = []
    const origUser = process.env.USER
    try {
      delete process.env.USER
      stubSpawnSync(() => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }), calls)
      readActiveCredentials()
      const aIdx = calls[0]?.cmd.indexOf('-a') ?? -1
      expect(calls[0]?.cmd[aIdx + 1]).toBe('user')
    } finally {
      if (origUser !== undefined) process.env.USER = origUser
    }
  })
})

describe('writeActiveCredentials', () => {
  it('uses the argv `-w <value>` form (with -U for idempotent updates)', () => {
    // Argv form is required because:
    //   1. `security`'s stdin-prompt form has an undocumented 128-byte cap
    //      (pinned by the integration test).
    //   2. `bun:ffi` to `SecKeychainAddGenericPassword` works but creates
    //      items with a cvault-binary-only ACL — every cross-binary read
    //      from `security` or Claude Code triggers a SecurityAgent prompt.
    // Staying inside `/usr/bin/security` for both read and write keeps
    // all cvault-managed items under the same Apple-signed binary's ACL.
    // See `keychain.ts` writeActiveCredentials docstring for the full
    // trade-off rationale.
    const calls: SpawnCall[] = []
    stubSpawnSync(() => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }), calls)

    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-X' } })
    writeActiveCredentials(blob)

    const cmd = calls[0]?.cmd ?? []
    expect(cmd[0]).toBe('security')
    expect(cmd).toContain('add-generic-password')
    expect(cmd).toContain('-U')
    expect(cmd).toContain('-w')
    const wIdx = cmd.indexOf('-w')
    expect(cmd[wIdx + 1]).toBe(blob)
    const sIdx = cmd.indexOf('-s')
    expect(cmd[sIdx + 1]).toBe(KEYCHAIN_SERVICE)
  })

  it('throws NativeKeychainError on non-zero exit', () => {
    stubSpawnSync(() => ({
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('boom'),
    }))
    expect(() => writeActiveCredentials('{}')).toThrow(NativeKeychainError)
  })

  it('classifies exit 51 as auth-denied with a partition-list hint', () => {
    stubSpawnSync(() => ({
      exitCode: 51,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('SecKeychainItemCopyContent: User interaction is not allowed.'),
    }))
    try {
      writeActiveCredentials('{}')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(NativeKeychainError)
      const e = err as NativeKeychainError
      expect(e.message).toMatch(/auth-denied/i)
      expect(e.message).toMatch(/cvault add|re-capture|another app/i)
    }
  })
})

describe('deleteActiveCredentials', () => {
  it('issues `security delete-generic-password` with service + account', () => {
    const calls: SpawnCall[] = []
    stubSpawnSync(() => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }), calls)

    deleteActiveCredentials()
    const cmd = calls[0]?.cmd ?? []
    expect(cmd).toContain('security')
    expect(cmd).toContain('delete-generic-password')
    expect(cmd).toContain(KEYCHAIN_SERVICE)
  })

  it('treats exit 44 (not found) as a no-op (does NOT throw)', () => {
    stubSpawnSync(() => ({
      exitCode: 44,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('SecKeychainSearchCopyNext: not found'),
    }))
    // Should NOT throw — deleting a missing entry is the desired end state.
    expect(() => deleteActiveCredentials()).not.toThrow()
  })

  it('throws NativeKeychainError on other non-zero exit', () => {
    stubSpawnSync(() => ({
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('locked'),
    }))
    expect(() => deleteActiveCredentials()).toThrow(NativeKeychainError)
  })
})

describe('platform guard (L4c)', () => {
  it('throws PlatformUnsupportedError when read is called on non-darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(() => readActiveCredentials()).toThrow(/does not yet support/i)
  })

  it('throws PlatformUnsupportedError when write is called on non-darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(() => writeActiveCredentials('{}')).toThrow(/does not yet support/i)
  })

  it('throws PlatformUnsupportedError when delete is called on non-darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(() => deleteActiveCredentials()).toThrow(/does not yet support/i)
  })
})

describe('error redaction (L4i)', () => {
  it('scrubs OAuth-token-shaped substrings from read error messages', () => {
    stubSpawnSync(() => ({
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('echoing back sk-ant-oat01-XYZAAAAAAAAAAAAAAAAAA'),
    }))
    try {
      readActiveCredentials()
      throw new Error('expected throw')
    } catch (err) {
      const e = err as NativeKeychainError
      expect(e.message).not.toMatch(/sk-ant-oat01-XYZ/)
      expect(e.message).toMatch(/<redacted>/)
    }
  })

  it('scrubs OAuth-token-shaped substrings from write error messages', () => {
    stubSpawnSync(() => ({
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('failed near sk-ant-ort01-ZZZAAAAAAAAAAAAAAAAAA'),
    }))
    try {
      writeActiveCredentials('{}')
      throw new Error('expected throw')
    } catch (err) {
      const e = err as NativeKeychainError
      expect(e.message).not.toMatch(/sk-ant-ort01-ZZZ/)
      expect(e.message).toMatch(/<redacted>/)
    }
  })
})
