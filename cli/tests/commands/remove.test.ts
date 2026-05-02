/**
 * Spec: §7 — `cvault remove <slot|email>`.
 *
 * `remove` is a SERVER-ONLY soft-delete: tombstones the row in Convex
 * and leaves local credentials untouched. The earlier "also clear local
 * if it matches the active sub" guard was removed after it surprised
 * users by silently logging them out of Claude Code; use `cvault clean`
 * for the local-wipe case.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runRemove } from '../../src/commands/remove'
import { makeVaultClient } from '../../src/convex/vaultClient'

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

beforeEach(() => {
  vi.mocked(makeVaultClient).mockReset()
})

describe('runRemove', () => {
  it('soft-removes the sub from the vault by email', async () => {
    const client = {
      mutation: vi.fn().mockResolvedValueOnce(null),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runRemove({ slotOrEmail: 'user@example.com' })

    expect(client.mutation).toHaveBeenCalledOnce()
    const args = client.mutation.mock.calls[0]?.[1] as Record<string, unknown>
    expect(args.email).toBe('user@example.com')
  })

  it('looks up email by slot when given a numeric arg', async () => {
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
    const args = client.mutation.mock.calls[0]?.[1] as Record<string, unknown>
    expect(args.email).toBe('c@d.com')
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

  it('propagates Convex softRemove errors verbatim', async () => {
    const client = {
      mutation: vi.fn().mockRejectedValueOnce(new Error('NOT_FOUND')),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await expect(runRemove({ slotOrEmail: 'foo@x.com' })).rejects.toThrow(/NOT_FOUND/)
  })
})
