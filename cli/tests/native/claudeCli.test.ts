/**
 * `addAccountInteractive` — spawn the user's `claude` CLI so they can
 * complete the OAuth flow in their terminal.
 *
 * This replaces `claude-swap --add-account`. After `claude` exits 0, the
 * Keychain has the new credentials and `~/.claude.json` has the new
 * `oauthAccount`. Caller (cvault add) then calls `buildEnvelope` to capture
 * what was just written.
 *
 * stdio is `inherit` — the user sees the OAuth prompt and can paste the
 * token / hit return. There is no timeout (the user controls completion).
 */
import { describe, expect, it, vi } from 'vitest'

describe('addAccountInteractive', () => {
  it('spawns `claude` with stdio inherit', async () => {
    let captured: { cmd: string[]; stdio: { stdin?: string; stdout?: string; stderr?: string } } | undefined
    const fakeProc = { exited: Promise.resolve(0) }
    vi.spyOn(Bun, 'spawn').mockImplementation(((opts: {
      cmd: string[]
      stdin?: string
      stdout?: string
      stderr?: string
    }) => {
      captured = {
        cmd: opts.cmd,
        stdio: { stdin: opts.stdin, stdout: opts.stdout, stderr: opts.stderr },
      }
      return fakeProc
    }) as unknown as typeof Bun.spawn)

    const { addAccountInteractive } = await import('../../src/native/claudeCli')
    await addAccountInteractive()
    expect(captured?.cmd[0]).toBe('claude')
    expect(captured?.stdio.stdin).toBe('inherit')
    expect(captured?.stdio.stdout).toBe('inherit')
    expect(captured?.stdio.stderr).toBe('inherit')
  })

  it('throws ClaudeCliMissingError on ENOENT', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('spawn ENOENT: claude')
    }) as unknown as typeof Bun.spawn)

    const { addAccountInteractive } = await import('../../src/native/claudeCli')
    await expect(addAccountInteractive()).rejects.toThrow(/claude.*install|install.*claude/i)
  })

  it('throws ClaudeCliMissingError on "No such file" message', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('No such file or directory: claude')
    }) as unknown as typeof Bun.spawn)

    const { addAccountInteractive } = await import('../../src/native/claudeCli')
    await expect(addAccountInteractive()).rejects.toThrow(/claude.*install|install.*claude/i)
  })

  it('rethrows unknown spawn errors verbatim', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('something exotic')
    }) as unknown as typeof Bun.spawn)

    const { addAccountInteractive } = await import('../../src/native/claudeCli')
    await expect(addAccountInteractive()).rejects.toThrow(/something exotic/)
  })

  it('throws when `claude` exits non-zero', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation((() => ({
      exited: Promise.resolve(1),
    })) as unknown as typeof Bun.spawn)

    const { addAccountInteractive } = await import('../../src/native/claudeCli')
    await expect(addAccountInteractive()).rejects.toThrow(/exited 1|non-zero|failed/i)
  })
})
