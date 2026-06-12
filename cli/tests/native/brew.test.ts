/**
 * `upgradeCvault` — shell out to Homebrew to pull the latest cvault release.
 *
 * The command exists to fix a recurring user-facing symptom: `brew upgrade`
 * alone often prints "Warning: ... already installed" right after a release
 * because Homebrew's auto-update window (up to ~24h) means the local tap
 * clone is stale and never learns about the new formula. `upgradeCvault`
 * runs an explicit `brew update` FIRST to force the tap refresh, then
 * `brew upgrade <tap-qualified formula>`.
 *
 * stdio is `inherit` so the user watches brew's own progress/output. We
 * mock `Bun.spawn` to assert the exact command sequence and error mapping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

interface SpawnCall {
  cmd: string[]
  stdin?: string
  stdout?: string
  stderr?: string
}

/**
 * Install a `Bun.spawn` spy that records each invocation and resolves
 * `exited` to the supplied codes in call order. A code of `'throw'`
 * makes that call throw the given error instead.
 */
function mockSpawn(exitCodes: Array<number | Error>): SpawnCall[] {
  const calls: SpawnCall[] = []
  let i = 0
  vi.spyOn(Bun, 'spawn').mockImplementation(((opts: SpawnCall) => {
    calls.push({ cmd: opts.cmd, stdin: opts.stdin, stdout: opts.stdout, stderr: opts.stderr })
    const outcome = exitCodes[i++]
    if (outcome instanceof Error) throw outcome
    return { exited: Promise.resolve(outcome) }
  }) as unknown as typeof Bun.spawn)
  return calls
}

afterEach(() => vi.restoreAllMocks())

describe('upgradeCvault', () => {
  it('runs `brew update` then `brew upgrade <formula>` with stdio inherit', async () => {
    const calls = mockSpawn([0, 0])
    const { upgradeCvault, CVAULT_FORMULA } = await import('../../src/native/brew')

    await upgradeCvault()

    expect(calls).toHaveLength(2)
    expect(calls[0]?.cmd).toEqual(['brew', 'update'])
    expect(calls[1]?.cmd).toEqual(['brew', 'upgrade', CVAULT_FORMULA])
    for (const call of calls) {
      expect(call.stdin).toBe('inherit')
      expect(call.stdout).toBe('inherit')
      expect(call.stderr).toBe('inherit')
    }
  })

  it('upgrades the fully tap-qualified formula name', async () => {
    mockSpawn([0, 0])
    const { CVAULT_FORMULA } = await import('../../src/native/brew')
    // A bare `cvault` could resolve to a same-named formula in another tap;
    // the tap-qualified name is unambiguous.
    expect(CVAULT_FORMULA).toBe('flatoutsolutions/cvault/cvault')
  })

  it('warns but STILL runs `brew upgrade` when `brew update` exits non-zero', async () => {
    // `brew update` legitimately exits non-zero on partial/transient
    // failures (an unrelated tap fails to fetch) while still refreshing
    // our tap — aborting would defeat the command's purpose.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls = mockSpawn([1, 0])
    const { upgradeCvault } = await import('../../src/native/brew')

    await expect(upgradeCvault()).resolves.toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.cmd).toEqual(['brew', 'upgrade', 'flatoutsolutions/cvault/cvault'])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/brew update.*exited 1/i))
  })

  it('throws when `brew upgrade` exits non-zero', async () => {
    mockSpawn([0, 1])
    const { upgradeCvault } = await import('../../src/native/brew')
    await expect(upgradeCvault()).rejects.toThrow(/brew upgrade.*exited 1|exited 1/i)
  })

  it('throws BrewMissingError on a real-Bun missing-binary error (ENOENT on err.code, not message)', async () => {
    // Bun 1.3.x throws `Executable not found in $PATH: "brew"` with
    // `code: 'ENOENT'` — the message contains NEITHER 'ENOENT' nor 'No such
    // file', so detection MUST key off err.code or the install hint is dead.
    const enoent = Object.assign(new Error('Executable not found in $PATH: "brew"'), { code: 'ENOENT' })
    mockSpawn([enoent])
    const { upgradeCvault } = await import('../../src/native/brew')
    await expect(upgradeCvault()).rejects.toThrow(/Homebrew.*not installed|install.*Homebrew|brew\.sh/i)
  })

  it('throws BrewMissingError when the message contains ENOENT (other runtimes)', async () => {
    mockSpawn([new Error('spawn ENOENT: brew')])
    const { upgradeCvault } = await import('../../src/native/brew')
    await expect(upgradeCvault()).rejects.toThrow(/Homebrew.*not installed|install.*Homebrew|brew\.sh/i)
  })

  it('throws BrewMissingError on a "No such file" spawn message', async () => {
    mockSpawn([new Error('No such file or directory: brew')])
    const { upgradeCvault } = await import('../../src/native/brew')
    await expect(upgradeCvault()).rejects.toThrow(/Homebrew.*not installed|install.*Homebrew|brew\.sh/i)
  })

  it('rethrows unknown spawn errors verbatim', async () => {
    mockSpawn([new Error('something exotic')])
    const { upgradeCvault } = await import('../../src/native/brew')
    await expect(upgradeCvault()).rejects.toThrow(/something exotic/)
  })
})
