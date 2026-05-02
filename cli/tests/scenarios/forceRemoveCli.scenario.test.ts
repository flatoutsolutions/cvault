/**
 * Scenario #10 (CLI half) — Force remove via `cvault remove <slot|email>`.
 *
 * Plan: docs/research/scenario-tests-plan.md §4.10. The plan splits this
 * into a frontend half (force-remove from the dashboard) and a CLI half
 * (`cvault remove` then `cvault list` no longer shows the sub). This
 * file covers the CLI half.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7
 *  (`cvault remove`) + §8 + §10 (soft delete behavior).
 *
 * What this scenario covers end-to-end:
 *  - `runRemove(email)` dispatches the typed
 *    `api.subscriptions.mutations.softRemove` ref FIRST.
 *  - Local credentials are cleared ONLY when the removed sub matches
 *    the currently-active local account (H4 fix).
 *  - If the server mutation fails, the local credentials are untouched.
 *  - Round-trip via `runList`: after removal, `cvault list` no longer
 *    renders the soft-removed sub.
 *  - When the user passes a slot number, the CLI resolves it via
 *    `listForUser` first.
 */
import { api } from '@cvault/convex/api'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runList } from '../../src/commands/list'
import { runRemove } from '../../src/commands/remove'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { getActiveAccount, removeAccount } from '../../src/credentials'
import {
  SAMPLE_OAUTH_BLOB,
  cleanupTempHome,
  createFakeVaultClient,
  getCall,
  makeSub,
  refName,
  setupTempHome,
} from './_helpers'

vi.mock('../../src/credentials', () => ({
  removeAccount: vi.fn().mockResolvedValue(undefined),
  getActiveAccount: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

let tempHome: string

beforeEach(() => {
  tempHome = setupTempHome('cvault-remove-test-')
  vi.mocked(getActiveAccount).mockReset()
  vi.mocked(removeAccount).mockReset()
  vi.mocked(removeAccount).mockResolvedValue(undefined)
})

afterEach(() => {
  cleanupTempHome(tempHome)
})

describe('Scenario #10 (CLI half) — `cvault remove` + listAfterRemove', () => {
  it('calls softRemove then clears local credentials when the removed sub IS the active one', async () => {
    const sub = await makeSub({
      email: 'gone@example.com',
      slot: 1,
      plaintextBlob: SAMPLE_OAUTH_BLOB,
    })
    const fake = createFakeVaultClient({ subscriptions: [sub] })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'gone@example.com' })

    const order: string[] = []
    fake.mutation.mockImplementationOnce((ref: unknown, args?: Record<string, unknown>) => {
      order.push('convex')
      const email = (args ?? {}).email
      for (const s of fake.state.subscriptions.values()) {
        if (s.email === email && s.removedAt === undefined) {
          s.removedAt = Date.now()
        }
      }
      expect(refName(ref)).toBe(getFunctionName(api.subscriptions.mutations.softRemove))
      return Promise.resolve(null)
    })
    vi.mocked(removeAccount).mockImplementationOnce(async () => {
      order.push('local')
    })

    await runRemove({ slotOrEmail: 'gone@example.com' })

    expect(order).toEqual(['convex', 'local'])
    expect(removeAccount).toHaveBeenCalledWith('gone@example.com')
  })

  it('does NOT touch the local credentials when the removed sub is NOT the active one (H4)', async () => {
    const sub = await makeSub({
      email: 'archived@example.com',
      slot: 1,
      plaintextBlob: SAMPLE_OAUTH_BLOB,
    })
    const fake = createFakeVaultClient({ subscriptions: [sub] })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)
    // The active account is unrelated to the one being removed.
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'still-here@example.com' })

    fake.mutation.mockResolvedValueOnce(null)

    await runRemove({ slotOrEmail: 'archived@example.com' })

    // Convex side ran. Local clear did not.
    expect(fake.mutation).toHaveBeenCalledOnce()
    expect(removeAccount).not.toHaveBeenCalled()
  })

  it('does NOT touch the local Keychain when the server mutation fails', async () => {
    const sub = await makeSub({
      email: 'survives@example.com',
      slot: 1,
      plaintextBlob: SAMPLE_OAUTH_BLOB,
    })
    const fake = createFakeVaultClient({ subscriptions: [sub] })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'survives@example.com' })

    fake.mutation.mockRejectedValueOnce(new Error('NOT_FOUND'))

    await expect(runRemove({ slotOrEmail: 'survives@example.com' })).rejects.toThrow(/NOT_FOUND/)

    expect(removeAccount).not.toHaveBeenCalled()
    // Server-side state untouched: row is still active.
    expect(sub.removedAt).toBeUndefined()
  })

  it('resolves a numeric slot to the matching email before softRemove', async () => {
    const subs = await Promise.all([
      makeSub({ email: 'one@x.com', slot: 1, plaintextBlob: SAMPLE_OAUTH_BLOB }),
      makeSub({ email: 'two@x.com', slot: 2, plaintextBlob: SAMPLE_OAUTH_BLOB }),
    ])
    const fake = createFakeVaultClient({ subscriptions: subs })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'two@x.com' })

    await runRemove({ slotOrEmail: '2' })

    // Resolved slot 2 -> email 'two@x.com' via listForUser.
    expect(fake.query).toHaveBeenCalledOnce()
    expect(refName(getCall(fake.query, 0).ref)).toBe(getFunctionName(api.subscriptions.queries.listForUser))
    // Then dispatched softRemove with the resolved email.
    expect(fake.mutation).toHaveBeenCalledOnce()
    expect(getCall(fake.mutation, 0).args?.email).toBe('two@x.com')
    // Local clear keyed off the resolved EMAIL (not the original numeric arg).
    expect(removeAccount).toHaveBeenCalledWith('two@x.com')
  })

  it('after remove, runList no longer shows the sub (round-trip via listForUser)', async () => {
    const subs = await Promise.all([
      makeSub({ email: 'keep@x.com', slot: 1, plaintextBlob: SAMPLE_OAUTH_BLOB }),
      makeSub({ email: 'drop@x.com', slot: 2, plaintextBlob: SAMPLE_OAUTH_BLOB }),
    ])
    const fake = createFakeVaultClient({ subscriptions: subs })
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'keep@x.com' })

    // Step 1: remove drop@x.com — keep@x.com is active, so removeAccount
    // should NOT fire on this removal (H4 fix).
    await runRemove({ slotOrEmail: 'drop@x.com' })
    expect(removeAccount).not.toHaveBeenCalled()

    // Step 2: list — drop@x.com must not appear.
    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })
    await runList()
    const out = captured.join('\n')
    expect(out).toContain('keep@x.com')
    expect(out).not.toContain('drop@x.com')
  })

  it('renders the empty-state message after removing the sole sub', async () => {
    const sub = await makeSub({
      email: 'only@x.com',
      slot: 1,
      plaintextBlob: SAMPLE_OAUTH_BLOB,
    })
    const fake = createFakeVaultClient({ subscriptions: [sub] })
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'only@x.com' })

    await runRemove({ slotOrEmail: 'only@x.com' })

    vi.mocked(getActiveAccount).mockReturnValueOnce(null)
    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })
    await runList()
    expect(captured.join('\n')).toMatch(/no subscriptions/i)
  })
})
