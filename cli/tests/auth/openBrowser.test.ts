/**
 * Open a URL in the user's default browser by shelling to the platform's
 * "open this thing" tool: `open` on macOS, `xdg-open` on Linux. We test
 * the wiring (correct command per platform), not the actual browser launch.
 */
import { describe, expect, it, vi } from 'vitest'

import { openBrowser } from '../../src/auth/openBrowser'

interface SpawnCall {
  cmd: string[]
}

interface SpawnOpts {
  cmd: string[]
}

interface FakeProc {
  exited: Promise<number>
}

function stubSpawn(
  exitCode: number,
  calls: SpawnCall[]
): { restore: () => void } {
  const spy = vi.spyOn(Bun, 'spawn').mockImplementation(((opts: SpawnOpts) => {
    calls.push({ cmd: opts.cmd })
    return { exited: Promise.resolve(exitCode) } as FakeProc
  }) as unknown as typeof Bun.spawn)
  return { restore: () => spy.mockRestore() }
}

describe('openBrowser', () => {
  it('uses `open` on macOS', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const calls: SpawnCall[] = []
    stubSpawn(0, calls)
    await openBrowser('https://example.com/auth')
    expect(calls[0]?.cmd).toEqual(['open', 'https://example.com/auth'])
    platformSpy.mockRestore()
  })

  it('uses `xdg-open` on Linux', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const calls: SpawnCall[] = []
    stubSpawn(0, calls)
    await openBrowser('https://example.com/auth')
    expect(calls[0]?.cmd).toEqual(['xdg-open', 'https://example.com/auth'])
    platformSpy.mockRestore()
  })

  it('uses `start` on Windows', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const calls: SpawnCall[] = []
    stubSpawn(0, calls)
    await openBrowser('https://example.com/auth')
    // `start` is a cmd builtin; we shell via `cmd /c start "" <url>`.
    expect(calls[0]?.cmd[0]).toBe('cmd')
    expect(calls[0]?.cmd).toContain('https://example.com/auth')
    platformSpy.mockRestore()
  })

  it('does not throw on non-zero exit (best-effort: user can copy/paste URL)', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const calls: SpawnCall[] = []
    stubSpawn(1, calls)
    await expect(openBrowser('https://example.com')).resolves.toBeUndefined()
    platformSpy.mockRestore()
  })
})
