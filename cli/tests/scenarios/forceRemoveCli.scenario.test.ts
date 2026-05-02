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
 *    `api.subscriptions.mutations.softRemove` ref FIRST. Server is the
 *    source of truth — we touch Convex before mutating the local
 *    Keychain.
 *  - Only after the mutation resolves does `runRemove` invoke
 *    `claude-swap --remove-account` for the local cleanup.
 *  - If the server mutation fails, the local Keychain is left intact.
 *  - Round-trip via `runList`: after removal, `cvault list` no longer
 *    renders the soft-removed sub (the fake's `listForUser` mirrors
 *    the real handler's `removedAt` filter).
 *  - When the user passes a slot number (not an email), the CLI resolves
 *    the email via `listForUser` first, so `softRemove({email})` gets
 *    the right argument.
 */
import { api } from '@cvault/convex/api'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeAccount, status } from '../../src/claudeSwap'
import { runList } from '../../src/commands/list'
import { runRemove } from '../../src/commands/remove'
import { makeVaultClient } from '../../src/convex/vaultClient'
import {
  SAMPLE_OAUTH_BLOB,
  cleanupTempHome,
  createFakeVaultClient,
  getCall,
  makeSub,
  refName,
  setupTempHome,
} from './_helpers'

vi.mock('../../src/claudeSwap', () => ({
  removeAccount: vi.fn(),
  status: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

let tempHome: string

beforeEach(() => {
  tempHome = setupTempHome('cvault-remove-test-')
})

afterEach(() => {
  cleanupTempHome(tempHome)
})

describe('Scenario #10 (CLI half) — `cvault remove` + listAfterRemove', () => {
  it('calls softRemove then claude-swap --remove-account, in that order', async () => {
    const sub = await makeSub({
      email: 'gone@example.com',
      slot: 1,
      plaintextBlob: SAMPLE_OAUTH_BLOB,
    })
    const fake = createFakeVaultClient({ subscriptions: [sub] })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)

    // Track ordering: convex mutation must happen before the local
    // Keychain remove.
    const order: string[] = []
    fake.mutation.mockImplementationOnce((ref: unknown, args?: Record<string, unknown>) => {
      order.push('convex')
      // Mirror the real fake's softRemove path so the round-trip
      // listForUser test below sees `removedAt` set. We do this via the
      // standard handler by calling it; the easier path is to mark
      // removedAt directly on the seeded sub.
      const email = (args ?? {}).email
      for (const s of fake.state.subscriptions.values()) {
        if (s.email === email && s.removedAt === undefined) {
          s.removedAt = Date.now()
        }
      }
      // Verify the dispatched ref is the typed softRemove proxy.
      expect(refName(ref)).toBe(getFunctionName(api.subscriptions.mutations.softRemove))
      return Promise.resolve(null)
    })
    vi.mocked(removeAccount).mockImplementationOnce(() => {
      order.push('claude-swap')
    })

    await runRemove({ slotOrEmail: 'gone@example.com' })

    expect(order).toEqual(['convex', 'claude-swap'])
    expect(removeAccount).toHaveBeenCalledWith('gone@example.com')
  })

  it('does NOT touch the local Keychain when the server mutation fails', async () => {
    const sub = await makeSub({
      email: 'survives@example.com',
      slot: 1,
      plaintextBlob: SAMPLE_OAUTH_BLOB,
    })
    const fake = createFakeVaultClient({ subscriptions: [sub] })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)

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

    await runRemove({ slotOrEmail: '2' })

    // Resolved slot 2 -> email 'two@x.com' via listForUser.
    expect(fake.query).toHaveBeenCalledOnce()
    expect(refName(getCall(fake.query, 0).ref)).toBe(getFunctionName(api.subscriptions.queries.listForUser))
    // Then dispatched softRemove with the resolved email.
    expect(fake.mutation).toHaveBeenCalledOnce()
    expect(getCall(fake.mutation, 0).args?.email).toBe('two@x.com')
    // claude-swap got the slot number form (matches the existing
    // tests/commands/remove.test.ts contract).
    expect(removeAccount).toHaveBeenCalledWith(2)
  })

  it('after remove, runList no longer shows the sub (round-trip via listForUser)', async () => {
    const subs = await Promise.all([
      makeSub({ email: 'keep@x.com', slot: 1, plaintextBlob: SAMPLE_OAUTH_BLOB }),
      makeSub({ email: 'drop@x.com', slot: 2, plaintextBlob: SAMPLE_OAUTH_BLOB }),
    ])
    const fake = createFakeVaultClient({ subscriptions: subs })
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    // Step 1: remove drop@x.com
    await runRemove({ slotOrEmail: 'drop@x.com' })
    expect(removeAccount).toHaveBeenCalledOnce()

    // Step 2: list — drop@x.com must not appear.
    vi.mocked(status).mockReturnValueOnce('Active account: 1 (keep@x.com)')
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

    await runRemove({ slotOrEmail: 'only@x.com' })

    vi.mocked(status).mockReturnValueOnce('No active account')
    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })
    await runList()
    expect(captured.join('\n')).toMatch(/no subscriptions/i)
  })
})
