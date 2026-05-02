/**
 * Spec: §7 — `cvault remove <slot|email>`.
 *
 * Order of operations:
 *   1. Resolve slot-or-email → email via Convex `listForUser` (if numeric).
 *   2. Server-side soft-remove via `api.subscriptions.mutations.softRemove`.
 *   3. ONLY when the removed sub matches the currently-active local
 *      account: clear the local credentials via `removeAccount` →
 *      `clearActive`.
 *
 * The "conditionally clear" guard prevents `cvault remove <other-slot>`
 * from silently logging the user out of an unrelated active account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runRemove } from '../../src/commands/remove'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { getActiveAccount, removeAccount } from '../../src/credentials'

vi.mock('../../src/credentials', () => ({
  removeAccount: vi.fn().mockResolvedValue(undefined),
  getActiveAccount: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

// Reset the mock implementations between tests so a `mockReturnValueOnce`
// queued by a test that errored before consuming it doesn't leak into
// the next test.
beforeEach(() => {
  vi.mocked(getActiveAccount).mockReset()
  vi.mocked(removeAccount).mockReset()
  vi.mocked(removeAccount).mockResolvedValue(undefined)
  vi.mocked(makeVaultClient).mockReset()
})

describe('runRemove — match against active account', () => {
  it('clears local credentials when the removed sub IS the active local account', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'user@example.com' })
    const order: string[] = []
    const client = {
      mutation: vi.fn().mockImplementation(() => {
        order.push('convex')
        return Promise.resolve(null)
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)
    vi.mocked(removeAccount).mockImplementationOnce(async () => {
      order.push('local')
    })

    await runRemove({ slotOrEmail: 'user@example.com' })

    expect(order).toEqual(['convex', 'local'])
    const mutationArgs = client.mutation.mock.calls[0]?.[1] as Record<string, unknown>
    expect(mutationArgs.email).toBe('user@example.com')
    expect(removeAccount).toHaveBeenCalledWith('user@example.com')
  })

  it('does NOT clear local credentials when the removed sub is NOT the active one', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'still-active@example.com' })
    const client = {
      mutation: vi.fn().mockResolvedValueOnce(null),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runRemove({ slotOrEmail: 'archived@example.com' })

    expect(client.mutation).toHaveBeenCalledOnce()
    expect(removeAccount).not.toHaveBeenCalled()
  })

  it('does NOT clear local when there is no active local account', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)
    const client = {
      mutation: vi.fn().mockResolvedValueOnce(null),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runRemove({ slotOrEmail: 'foo@example.com' })

    expect(removeAccount).not.toHaveBeenCalled()
  })
})

describe('runRemove — error paths', () => {
  it('does not invoke local clear when Convex softRemove fails', async () => {
    const client = {
      mutation: vi.fn().mockRejectedValueOnce(new Error('NOT_FOUND')),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'foo@x.com' })

    await expect(runRemove({ slotOrEmail: 'foo@x.com' })).rejects.toThrow(/NOT_FOUND/)
    expect(removeAccount).not.toHaveBeenCalled()
  })

  it('throws a clear error when the numeric slot does not exist', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([{ slot: 1, email: 'a@b.com' }]),
      mutation: vi.fn(),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)

    await expect(runRemove({ slotOrEmail: '99' })).rejects.toThrow(/slot 99/i)
    expect(client.mutation).not.toHaveBeenCalled()
  })
})

describe('runRemove — slot resolution', () => {
  it('looks up email by slot when given a numeric arg, then matches against active', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'c@d.com' })
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
    // The local clear is by the resolved email, not the original slot string.
    expect(removeAccount).toHaveBeenCalledWith('c@d.com')
  })
})

describe('runRemove — case-insensitive active match (R2)', () => {
  it('clears local creds when removed email differs from active email only by case', async () => {
    // Vault has the email lowercase; the active local oauthAccount has
    // it title-case. Strict-case compare would skip the local clear when
    // it should fire (the user is actively using this credential).
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'Stefan@example.com' })
    const client = {
      mutation: vi.fn().mockResolvedValueOnce(null),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runRemove({ slotOrEmail: 'stefan@example.com' })

    expect(removeAccount).toHaveBeenCalledOnce()
    expect(removeAccount).toHaveBeenCalledWith('stefan@example.com')
  })

  it('clears local creds in the reverse case (active=lower, vault=mixed)', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'stefan@example.com' })
    const client = {
      mutation: vi.fn().mockResolvedValueOnce(null),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runRemove({ slotOrEmail: 'STEFAN@Example.COM' })

    expect(removeAccount).toHaveBeenCalledOnce()
  })
})
