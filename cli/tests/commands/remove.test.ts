/**
 * Spec: §7 — `cvault remove <slot|email>`.
 *
 * Order of operations matters:
 *   1. `api.subscriptions.mutations.softRemove` (server-side) — mark the
 *      vault row as removed.
 *   2. `claude-swap --remove-account` (local) — drop the Keychain entry.
 *
 * If step 1 fails, we don't run step 2 (server is the source of truth).
 * If step 2 fails, the server has already soft-removed — the user can
 * re-run with `--force-local` to retry the Keychain delete.
 */
import { describe, expect, it, vi } from 'vitest'

import { removeAccount } from '../../src/claudeSwap'
import { runRemove } from '../../src/commands/remove'
import { makeVaultClient } from '../../src/convex/vaultClient'

vi.mock('../../src/claudeSwap', () => ({
  removeAccount: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

describe('runRemove', () => {
  it('calls Convex softRemove first, then claude-swap remove-account', async () => {
    const order: string[] = []
    const client = {
      mutation: vi.fn().mockImplementation(() => {
        order.push('convex')
        return Promise.resolve(null)
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)
    vi.mocked(removeAccount).mockImplementationOnce(() => {
      order.push('claude-swap')
    })

    await runRemove({ slotOrEmail: 'user@example.com' })

    expect(order).toEqual(['convex', 'claude-swap'])
    const mutationArgs = client.mutation.mock.calls[0]?.[1] as Record<string, unknown>
    expect(mutationArgs.email).toBe('user@example.com')
    expect(removeAccount).toHaveBeenCalledWith('user@example.com')
  })

  it('does not invoke claude-swap when Convex softRemove fails', async () => {
    const client = {
      mutation: vi.fn().mockRejectedValueOnce(new Error('NOT_FOUND')),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await expect(runRemove({ slotOrEmail: 'user@example.com' })).rejects.toThrow(/NOT_FOUND/)
    expect(removeAccount).not.toHaveBeenCalled()
  })

  it('looks up email by slot when given a numeric arg (calls list query first)', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([
        { slot: 1, email: 'a@b.com' },
        { slot: 2, email: 'c@d.com' },
      ]),
      mutation: vi.fn().mockResolvedValueOnce(null),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runRemove({ slotOrEmail: '2' })

    expect(client.query).toHaveBeenCalledOnce()
    const mutationArgs = client.mutation.mock.calls[0]?.[1] as Record<string, unknown>
    expect(mutationArgs.email).toBe('c@d.com')
    expect(removeAccount).toHaveBeenCalledWith(2)
  })

  it('throws a clear error when the numeric slot does not exist', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([{ slot: 1, email: 'a@b.com' }]),
      mutation: vi.fn(),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await expect(runRemove({ slotOrEmail: '99' })).rejects.toThrow(/slot 99/i)
    expect(client.mutation).not.toHaveBeenCalled()
  })
})
