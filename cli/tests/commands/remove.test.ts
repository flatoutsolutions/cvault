/**
 * Spec: §7 — `cvault remove <slot|email>`.
 *
 * `remove` does a server-side soft-delete and ALSO clears the local
 * credentials when the removed sub matches the currently-active local
 * account (R4-H4 conditional-clear). Removing a non-active sub leaves
 * the local Keychain untouched. See `cli/src/commands/remove.ts` for
 * the full rationale.
 *
 * These unit tests don't stub `getActiveAccount`, so on a test machine
 * with no real `claude.json` the active-account check returns null and
 * the local-clear branch is skipped — the tests focus on the server
 * dispatch + slot-resolution paths. The active-vs-inactive branching is
 * exercised in `tests/scenarios/forceRemoveCli.scenario.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runRemove } from '../../src/commands/remove'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { noopWithMachineLabel, noopWithMeta } from '../scenarios/_helpers'

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
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

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
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

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
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    await expect(runRemove({ slotOrEmail: '99' })).rejects.toThrow(/slot 99/i)
    expect(client.mutation).not.toHaveBeenCalled()
  })

  it('propagates Convex softRemove errors verbatim', async () => {
    const client = {
      mutation: vi.fn().mockRejectedValueOnce(new Error('NOT_FOUND')),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withMeta: noopWithMeta,
    } as never)

    await expect(runRemove({ slotOrEmail: 'foo@x.com' })).rejects.toThrow(/NOT_FOUND/)
  })
})
