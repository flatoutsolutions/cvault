import { afterEach, describe, expect, it, vi } from 'vitest'

import { runUpgrade } from '../../src/commands/upgrade'
import { upgradeCvault } from '../../src/native/brew'

vi.mock('../../src/native/brew')

afterEach(() => vi.clearAllMocks())

describe('runUpgrade', () => {
  it('delegates to upgradeCvault and prints a success line', async () => {
    vi.mocked(upgradeCvault).mockResolvedValue()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runUpgrade()
    expect(upgradeCvault).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/up to date/i))
  })

  it('propagates failures from upgradeCvault', async () => {
    vi.mocked(upgradeCvault).mockRejectedValue(new Error('brew upgrade exited 1'))
    await expect(runUpgrade()).rejects.toThrow(/exited 1/)
  })
})
