import { afterEach, describe, expect, it, vi } from 'vitest'

import { deleteSession } from '../../src/auth/session'
import { pullHookCommand } from '../../src/commands/login'
import { runLogout } from '../../src/commands/logout'
import { uninstallPullHook } from '../../src/native/claudeSettings'

vi.mock('../../src/native/claudeSettings')
vi.mock('../../src/auth/session')

afterEach(() => vi.clearAllMocks())

describe('pullHookCommand', () => {
  it('invokes `cvault` on PATH, not process.execPath/bun (Homebrew ships a bun shim)', () => {
    const cmd = pullHookCommand()
    expect(cmd).toBe('cvault pull')
    expect(cmd).not.toContain('bun')
  })
})

describe('runLogout', () => {
  it('removes the hook and deletes the session', async () => {
    vi.mocked(uninstallPullHook).mockResolvedValue()
    vi.mocked(deleteSession).mockResolvedValue()
    await runLogout()
    expect(uninstallPullHook).toHaveBeenCalledTimes(1)
    expect(deleteSession).toHaveBeenCalledTimes(1)
  })

  it('still deletes the session when hook removal throws (best-effort)', async () => {
    vi.mocked(uninstallPullHook).mockRejectedValue(new Error('malformed settings.json'))
    vi.mocked(deleteSession).mockResolvedValue()
    await runLogout()
    expect(deleteSession).toHaveBeenCalledTimes(1)
  })
})
