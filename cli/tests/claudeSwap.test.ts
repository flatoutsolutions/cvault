/**
 * Spec: §7, §10, §11 — wrapping `claude-swap` via `Bun.spawn`.
 *
 * The wrapper is the single boundary between cvault and the local Mac
 * Keychain. Every read/write goes through here. Tests pin the contract:
 *
 * - returns parsed stdout on exit 0
 * - throws `ClaudeSwapError` on non-zero exit
 * - throws `ClaudeSwapMissingError` on ENOENT
 * - 30-second default timeout (Keychain prompts can hang)
 * - export envelope JSON is parsed against the verified shape
 * - import accepts the verified shape via stdin
 */
import { describe, expect, it, vi } from 'vitest'

import {
  ClaudeSwapError,
  ClaudeSwapMissingError,
  exportAccount,
  importEnvelope,
  removeAccount,
  runClaudeSwap,
  status,
  switchTo,
} from '../src/claudeSwap'
import { singleAccountEnvelope } from './fixtures/envelopes/singleAccount'

interface SpawnCall {
  cmd: string[]
  stdin: string | undefined
  timeout: number
}

interface FakeSyncResult {
  exitCode: number | null
  stdout: Uint8Array
  stderr: Uint8Array
}

interface SpawnOpts {
  cmd: string[]
  stdin?: unknown
  timeout?: number
}

/**
 * Stub `Bun.spawnSync` so we don't actually exec `claude-swap`. We capture
 * each invocation for assertions.
 */
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
    const call: SpawnCall = {
      cmd: opts.cmd,
      stdin,
      timeout: opts.timeout ?? 0,
    }
    calls.push(call)
    const out = impl(call)
    if (out instanceof Error) throw out
    return out
  }) as unknown as typeof Bun.spawnSync)
  return { calls, restore: () => spy.mockRestore() }
}

describe('runClaudeSwap', () => {
  it('returns decoded stdout/stderr on exit 0', () => {
    const calls: SpawnCall[] = []
    stubSpawnSync(
      () => ({
        exitCode: 0,
        stdout: new TextEncoder().encode('hello'),
        stderr: new TextEncoder().encode('warn: x'),
      }),
      calls
    )
    const result = runClaudeSwap(['--status'])
    expect(result.stdout).toBe('hello')
    expect(result.stderr).toBe('warn: x')
    expect(calls[0]?.cmd).toEqual(['claude-swap', '--status'])
  })

  it('applies a 30-second default timeout', () => {
    const calls: SpawnCall[] = []
    stubSpawnSync(
      () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }),
      calls
    )
    runClaudeSwap(['--status'])
    expect(calls[0]?.timeout).toBe(30_000)
  })

  it('honors a custom timeout', () => {
    const calls: SpawnCall[] = []
    stubSpawnSync(
      () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }),
      calls
    )
    runClaudeSwap(['--status'], { timeoutMs: 5_000 })
    expect(calls[0]?.timeout).toBe(5_000)
  })

  it('passes stdin as utf8 to the subprocess', () => {
    const calls: SpawnCall[] = []
    stubSpawnSync(
      () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }),
      calls
    )
    runClaudeSwap(['--import', '-'], { stdin: '{"hello":"world"}' })
    expect(calls[0]?.stdin).toBe('{"hello":"world"}')
  })

  it('throws ClaudeSwapError when exit code is non-zero, including stderr', () => {
    stubSpawnSync(() => ({
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('boom'),
    }))
    try {
      runClaudeSwap(['--status'])
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeSwapError)
      const e = err as ClaudeSwapError
      expect(e.exitCode).toBe(1)
      expect(e.stderr).toBe('boom')
      expect(e.message).toMatch(/--status/)
      expect(e.message).toMatch(/boom/)
    }
  })

  it('throws ClaudeSwapMissingError when Bun.spawnSync reports ENOENT', () => {
    stubSpawnSync(() => new Error('spawn ENOENT: claude-swap'))
    expect(() => runClaudeSwap(['--status'])).toThrow(ClaudeSwapMissingError)
  })

  it('throws ClaudeSwapMissingError when the error message says "No such file"', () => {
    stubSpawnSync(() => new Error('No such file or directory: claude-swap'))
    expect(() => runClaudeSwap(['--status'])).toThrow(ClaudeSwapMissingError)
  })

  it('rethrows unknown errors verbatim', () => {
    stubSpawnSync(() => new Error('something exotic'))
    expect(() => runClaudeSwap(['--status'])).toThrow(/something exotic/)
  })
})

describe('verb helpers', () => {
  it('exportAccount calls --export - --account <slot> and parses JSON', () => {
    const calls: SpawnCall[] = []
    const env = singleAccountEnvelope()
    stubSpawnSync(
      () => ({
        exitCode: 0,
        stdout: new TextEncoder().encode(JSON.stringify(env)),
        stderr: new Uint8Array(),
      }),
      calls
    )
    const parsed = exportAccount(1)
    expect(parsed).toEqual(env)
    // `--full` is required so claude-swap embeds the full `oauthAccount`
    // sub-document into `config`. Without it, `cvault switch` later trips
    // claude-swap's "Invalid oauthAccount in backup" validator on the
    // destination machine.
    expect(calls[0]?.cmd).toEqual([
      'claude-swap',
      '--export',
      '-',
      '--account',
      '1',
      '--full',
    ])
  })

  it('exportAccount accepts an email argument', () => {
    const calls: SpawnCall[] = []
    const env = singleAccountEnvelope({ email: 'a@b.com' })
    stubSpawnSync(
      () => ({
        exitCode: 0,
        stdout: new TextEncoder().encode(JSON.stringify(env)),
        stderr: new Uint8Array(),
      }),
      calls
    )
    exportAccount('a@b.com')
    expect(calls[0]?.cmd).toEqual([
      'claude-swap',
      '--export',
      '-',
      '--account',
      'a@b.com',
      '--full',
    ])
  })

  it('exportAccount throws ClaudeSwapError on non-JSON stdout', () => {
    stubSpawnSync(() => ({
      exitCode: 0,
      stdout: new TextEncoder().encode('not json'),
      stderr: new Uint8Array(),
    }))
    expect(() => exportAccount(1)).toThrow(ClaudeSwapError)
  })

  it('importEnvelope calls --import - with the JSON payload on stdin', () => {
    const calls: SpawnCall[] = []
    const env = singleAccountEnvelope()
    stubSpawnSync(
      () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }),
      calls
    )
    importEnvelope(env)
    expect(calls[0]?.cmd).toEqual(['claude-swap', '--import', '-'])
    expect(JSON.parse(calls[0]?.stdin ?? '')).toEqual(env)
  })

  it('importEnvelope adds --force when force=true', () => {
    const calls: SpawnCall[] = []
    stubSpawnSync(
      () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }),
      calls
    )
    importEnvelope(singleAccountEnvelope(), true)
    expect(calls[0]?.cmd).toEqual(['claude-swap', '--import', '-', '--force'])
  })

  it('switchTo calls --switch-to <id>', () => {
    const calls: SpawnCall[] = []
    stubSpawnSync(
      () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }),
      calls
    )
    switchTo(2)
    expect(calls[0]?.cmd).toEqual(['claude-swap', '--switch-to', '2'])
  })

  it('removeAccount calls --remove-account <id>', () => {
    const calls: SpawnCall[] = []
    stubSpawnSync(
      () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }),
      calls
    )
    removeAccount('a@b.com')
    expect(calls[0]?.cmd).toEqual(['claude-swap', '--remove-account', 'a@b.com'])
  })

  it('status returns the stdout of --status', () => {
    stubSpawnSync(() => ({
      exitCode: 0,
      stdout: new TextEncoder().encode('Active account: 1 (a@b.com)\n'),
      stderr: new Uint8Array(),
    }))
    expect(status()).toBe('Active account: 1 (a@b.com)\n')
  })
})
