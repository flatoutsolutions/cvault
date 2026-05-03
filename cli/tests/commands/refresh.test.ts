/**
 * Spec: §7 — `cvault refresh [slot|email]`.
 *
 * Manually triggers a server-side OAuth refresh for the given (or active)
 * sub via the public `api.subscriptions.actions.requestRefresh` action.
 *
 * The CLI takes a slot or email; the backend takes a `subId`. The CLI
 * resolves the slot/email to a subId via `listForUser`, then calls
 * `requestRefresh({ subId })`.
 */
import { type FunctionReference, getFunctionName } from 'convex/server'
import { describe, expect, it, vi } from 'vitest'

import { runRefresh } from '../../src/commands/refresh'
import { makeVaultClient } from '../../src/convex/vaultClient'

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

function refName(ref: unknown): string {
  // `api.x.y.z` returns a Proxy whose name we read via convex's
  // `getFunctionName` helper. This is what the convex client itself uses
  // to dispatch — assert against the same string.
  return getFunctionName(ref as FunctionReference<'query' | 'mutation' | 'action'>)
}

describe('runRefresh', () => {
  it('resolves a slot to a subId and calls api.subscriptions.actions.requestRefresh', async () => {
    const subId = 'sub_alice_1' as const
    const client = {
      query: vi.fn().mockResolvedValueOnce([
        { _id: subId, slot: 1, email: 'alice@example.com' },
        { _id: 'sub_alice_2', slot: 2, email: 'beth@example.com' },
      ]),
      action: vi.fn().mockResolvedValueOnce(null),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runRefresh({ slotOrEmail: '1' })

    // First the CLI fetches the user's subs to resolve the slot.
    expect(client.query).toHaveBeenCalledOnce()
    const queryRef: unknown = client.query.mock.calls[0]?.[0]
    expect(refName(queryRef)).toMatch(/listForUser/)

    // Then it calls the typed `api.subscriptions.actions.requestRefresh`
    // (NOT a string-keyed `refreshOAuthTokenForUser` proxy — that name
    // doesn't exist on the backend).
    expect(client.action).toHaveBeenCalledOnce()
    const actionRef: unknown = client.action.mock.calls[0]?.[0]
    expect(refName(actionRef)).toMatch(/requestRefresh/)
    const actionArgs = client.action.mock.calls[0]?.[1] as Record<string, unknown>
    // Backend's validator is { subId: v.id('subscriptions') } — the CLI
    // must pass a subId, NOT slotOrEmail.
    expect(actionArgs.subId).toBe(subId)
    expect(actionArgs.slotOrEmail).toBeUndefined()
  })

  it('resolves an email argument to its subId', async () => {
    const subId = 'sub_bob_3' as const
    const client = {
      query: vi.fn().mockResolvedValueOnce([
        { _id: 'sub_alice_1', slot: 1, email: 'alice@example.com' },
        { _id: subId, slot: 3, email: 'bob@example.com' },
      ]),
      action: vi.fn().mockResolvedValueOnce(null),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runRefresh({ slotOrEmail: 'bob@example.com' })

    const actionRef: unknown = client.action.mock.calls[0]?.[0]
    expect(refName(actionRef)).toMatch(/requestRefresh/)
    const actionArgs = client.action.mock.calls[0]?.[1] as Record<string, unknown>
    expect(actionArgs.subId).toBe(subId)
  })

  it('throws a clear error when no sub matches the slot', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockResolvedValueOnce(null),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await expect(runRefresh({ slotOrEmail: '99' })).rejects.toThrow(/no subscription/i)
    expect(client.action).not.toHaveBeenCalled()
  })

  it('throws a clear error when no sub matches the email', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockResolvedValueOnce(null),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await expect(runRefresh({ slotOrEmail: 'unknown@example.com' })).rejects.toThrow(/no subscription/i)
    expect(client.action).not.toHaveBeenCalled()
  })

  it('propagates Convex errors from the action call', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockRejectedValueOnce(new Error('500 boom')),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await expect(runRefresh({ slotOrEmail: '1' })).rejects.toThrow(/500/)
  })
})
