/**
 * Spec: §7 — `cvault refresh [--slot <slot>] [--force]`.
 *
 * Multi-laptop OAuth refresh coordinator. The CLI:
 *   1. Acquires the cvault credentials cross-process lock.
 *   2. Reads the local Keychain blob (when present) so it can ship it
 *      to the server as `localState`.
 *   3. Resolves --slot to a sub via `listForUser` (or defaults to slot 1
 *      when the local active sub matches a vault row).
 *   4. Calls `subscriptions.actions.refreshSub({ slot, localState, force })`.
 *   5. Compares the returned `contentHash` with a hash of local state.
 *      If different, writes the returned plaintext to the Keychain.
 *   6. Prints a one-line summary keyed off the action label.
 *   7. Releases the lock.
 *
 * These tests mock the convex client + the native primitives and assert
 * the orchestration: which Convex function is called, what gets sent,
 * whether the Keychain was written, and which line the user sees.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runRefresh } from '../../src/commands/refresh'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { readCredentials } from '../../src/native/credentialStore'
import { applyEnvelopeUnlocked } from '../../src/native/envelope'
import { withFileLock } from '../../src/native/lock'
import { noopWithMachineLabel, noopWithMeta, noopWithSessionId } from '../scenarios/_helpers'

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

vi.mock('../../src/native/credentialStore', () => ({
  readCredentials: vi.fn(),
  writeCredentials: vi.fn(),
  deleteCredentials: vi.fn(),
}))

vi.mock('../../src/native/envelope', async () => {
  const actual = await vi.importActual<typeof import('../../src/native/envelope')>('../../src/native/envelope')
  return {
    ...actual,
    applyEnvelopeUnlocked: vi.fn(),
  }
})

vi.mock('../../src/native/lock', () => ({
  // Identity wrapper — the lock is exercised in lock.test.ts. Here we
  // just want to verify `withFileLock` is the wrapping primitive AND
  // that the body runs under it.
  withFileLock: vi.fn(<T>(fn: () => Promise<T> | T) => Promise.resolve(fn())),
}))

// Test fixtures include the `config.oauthAccount` slice that real
// vault rows always carry (see add.ts:63-69 — `cvault add` captures it
// before encrypting). Without this slice, M5's safety check in
// buildEnvelopeFromPlaintext would refuse to apply the envelope.
const SAMPLE_LOCAL_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-LOCAL-AAAAAAAAAAAAAAAA',
    refreshToken: 'sk-ant-ort01-LOCAL-BBBBBBBBBBBBBBBB',
    expiresAt: 1_900_000_000_000,
    scopes: ['user:inference'],
  },
  config: { oauthAccount: { emailAddress: 'x@example.com' } },
})

const SAMPLE_VAULT_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-VAULT-CCCCCCCCCCCCCCCC',
    refreshToken: 'sk-ant-ort01-VAULT-DDDDDDDDDDDDDDDD',
    expiresAt: 1_900_000_001_000,
    scopes: ['user:inference'],
  },
  config: { oauthAccount: { emailAddress: 'x@example.com' } },
})

// Plaintext blob WITHOUT `config.oauthAccount` — used by the M5 test
// to assert that buildEnvelopeFromPlaintext refuses to apply.
const PLAINTEXT_BLOB_NO_OAUTHACCOUNT = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-NOMETA-AAAAAAAAAAAAAAAA',
    refreshToken: 'sk-ant-ort01-NOMETA-BBBBBBBBBBBBBBBB',
    expiresAt: 1_900_000_001_000,
    scopes: ['user:inference'],
  },
})

beforeEach(() => {
  vi.mocked(makeVaultClient).mockReset()
  vi.mocked(readCredentials).mockReset()
  vi.mocked(applyEnvelopeUnlocked).mockReset()
  vi.mocked(withFileLock).mockClear()
})

describe('runRefresh', () => {
  it('acquires the cross-process credentials lock around the whole cycle', async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    const client = {
      query: vi.fn().mockResolvedValue([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockResolvedValue({
        email: 'x@example.com',
        slot: 1,
        plaintextBlob: SAMPLE_LOCAL_BLOB,
        contentHash: 'hash-of-local',
        action: 'inSync',
        expiresAt: 1_900_000_000_000,
        lastRefreshedAt: Date.now(),
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    await runRefresh({ slot: 1 })

    expect(withFileLock).toHaveBeenCalled()
  })

  it('passes the local Keychain blob to refreshSub as localState', async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    const client = {
      query: vi.fn().mockResolvedValue([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockResolvedValue({
        email: 'x@example.com',
        slot: 1,
        plaintextBlob: SAMPLE_LOCAL_BLOB,
        contentHash: 'hash-of-local',
        action: 'inSync',
        expiresAt: 1_900_000_000_000,
        lastRefreshedAt: Date.now(),
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    await runRefresh({ slot: 1 })

    const actionArgs = client.action.mock.calls[0]?.[1] as { slot: number; localState?: string }
    expect(actionArgs.slot).toBe(1)
    expect(actionArgs.localState).toBe(SAMPLE_LOCAL_BLOB)
  })

  it('passes localState as undefined when no local credentials exist', async () => {
    vi.mocked(readCredentials).mockReturnValue(null)
    const client = {
      query: vi.fn().mockResolvedValue([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockResolvedValue({
        email: 'x@example.com',
        slot: 1,
        plaintextBlob: SAMPLE_VAULT_BLOB,
        contentHash: 'hash-of-vault',
        action: 'pulledFresh',
        expiresAt: 1_900_000_001_000,
        lastRefreshedAt: Date.now(),
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    await runRefresh({ slot: 1 })

    const actionArgs = client.action.mock.calls[0]?.[1] as { slot: number; localState?: string }
    expect(actionArgs.slot).toBe(1)
    expect(actionArgs.localState).toBeUndefined()
  })

  it("does NOT write to the Keychain when the action returns 'inSync' and the hash matches", async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    // Compute the same sha256 hex the server would produce.
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update(SAMPLE_LOCAL_BLOB).digest('hex')

    const client = {
      query: vi.fn().mockResolvedValue([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockResolvedValue({
        email: 'x@example.com',
        slot: 1,
        plaintextBlob: SAMPLE_LOCAL_BLOB,
        contentHash: hash,
        action: 'inSync',
        expiresAt: 1_900_000_000_000,
        lastRefreshedAt: Date.now(),
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    await runRefresh({ slot: 1 })

    expect(applyEnvelopeUnlocked).not.toHaveBeenCalled()
  })

  it("writes the returned plaintext to the Keychain when the action returns 'pulledFresh'", async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    const client = {
      query: vi.fn().mockResolvedValue([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockResolvedValue({
        email: 'x@example.com',
        slot: 1,
        plaintextBlob: SAMPLE_VAULT_BLOB,
        contentHash: 'hash-vault-different',
        action: 'pulledFresh',
        expiresAt: 1_900_000_001_000,
        lastRefreshedAt: Date.now(),
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    await runRefresh({ slot: 1 })

    expect(applyEnvelopeUnlocked).toHaveBeenCalledOnce()
  })

  it("writes the returned plaintext to the Keychain when the action returns 'refreshedFromAnthropic'", async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    const client = {
      query: vi.fn().mockResolvedValue([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockResolvedValue({
        email: 'x@example.com',
        slot: 1,
        plaintextBlob: SAMPLE_VAULT_BLOB,
        contentHash: 'hash-of-newly-refreshed',
        action: 'refreshedFromAnthropic',
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
        lastRefreshedAt: Date.now(),
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    await runRefresh({ slot: 1 })

    expect(applyEnvelopeUnlocked).toHaveBeenCalledOnce()
  })

  it('passes force=true to the action when --force is set', async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    const client = {
      query: vi.fn().mockResolvedValue([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockResolvedValue({
        email: 'x@example.com',
        slot: 1,
        plaintextBlob: SAMPLE_VAULT_BLOB,
        contentHash: 'hash-refreshed',
        action: 'refreshedFromAnthropic',
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
        lastRefreshedAt: Date.now(),
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    await runRefresh({ slot: 1, force: true })

    const actionArgs = client.action.mock.calls[0]?.[1] as { force?: boolean }
    expect(actionArgs.force).toBe(true)
  })

  it('prints a concise message keyed off the returned action label', async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    const client = {
      query: vi.fn().mockResolvedValue([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockResolvedValue({
        email: 'x@example.com',
        slot: 1,
        plaintextBlob: SAMPLE_LOCAL_BLOB,
        contentHash: 'hash-adopted',
        action: 'adoptedLocal',
        expiresAt: Date.now() + 60 * 60 * 1000,
        lastRefreshedAt: Date.now(),
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runRefresh({ slot: 1 })

    expect(captured.join('\n')).toMatch(/pushed local|local.*vault|adopted/i)
  })

  it('throws a clear error message when the action throws RELOGIN_REQUIRED', async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    const client = {
      query: vi.fn().mockResolvedValue([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockRejectedValue(new Error('[Server Error] RELOGIN_REQUIRED: refresh token revoked')),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    await expect(runRefresh({ slot: 1 })).rejects.toThrow(/relogin|cvault add/i)
  })

  it('does not write the Keychain when the action throws', async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    const client = {
      query: vi.fn().mockResolvedValue([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockRejectedValue(new Error('500 boom')),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    await expect(runRefresh({ slot: 1 })).rejects.toThrow(/500/)
    expect(applyEnvelopeUnlocked).not.toHaveBeenCalled()
  })

  // M5: refuse to write a Keychain envelope when the vault row's plaintext
  // lacks `config.oauthAccount`. Otherwise refresh would succeed but
  // ~/.claude.json would not be populated, leaving Claude Code unable
  // to identify the account.
  it('M5: errors with an actionable message when the plaintext lacks config.oauthAccount', async () => {
    vi.mocked(readCredentials).mockReturnValue(null)
    const client = {
      query: vi.fn().mockResolvedValue([{ _id: 'sub_x', slot: 1, email: 'x@example.com' }]),
      action: vi.fn().mockResolvedValue({
        email: 'x@example.com',
        slot: 1,
        plaintextBlob: PLAINTEXT_BLOB_NO_OAUTHACCOUNT,
        contentHash: 'hash-no-meta',
        action: 'pulledFresh',
        expiresAt: 1_900_000_001_000,
        lastRefreshedAt: Date.now(),
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    await expect(runRefresh({ slot: 1 })).rejects.toThrow(/oauthAccount|cvault add/i)
    expect(applyEnvelopeUnlocked).not.toHaveBeenCalled()
  })
})

describe('refreshCommand argument parsing', () => {
  it('S4: rejects non-numeric --slot with a clean error before invoking runRefresh', async () => {
    // citty handlers receive `args` already shape-validated by the
    // declared argument type. We invoke the command's `run` directly to
    // exercise the parseInt/NaN guard. The expected behavior: throw a
    // clear "must be a number" error rather than letting `NaN` flow
    // through into runRefresh and crash with a confusing downstream
    // error (e.g. JSON.stringify of undefined slot, action call with
    // NaN slot).
    const { refreshCommand } = await import('../../src/commands/refresh')
    type RunArg = Parameters<NonNullable<typeof refreshCommand.run>>[0]
    const fakeCtx = {
      args: { slot: 'foo', force: false, all: false },
      cmd: refreshCommand,
      rawArgs: [],
      data: undefined,
    } as unknown as RunArg
    await expect(refreshCommand.run!(fakeCtx)).rejects.toThrow(/--slot.*number|got foo/i)
  })
})

describe('runRefresh --all', () => {
  // The `--all` flag iterates every sub for the user via
  // `subscriptions.queries.listForUser`, calls `refreshSub` per sub, and
  // reports per-sub status with a final summary. Exit code is 0 when
  // everything succeeded or skipped; 1 when any sub failed.
  it('iterates every sub from listForUser and calls refreshSub for each', async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)

    const subs = [
      { _id: 'sub_a', slot: 1, email: 'alice@example.com' },
      { _id: 'sub_b', slot: 2, email: 'bob@example.com' },
      { _id: 'sub_c', slot: 3, email: 'cara@example.com' },
    ]
    const client = {
      query: vi.fn().mockResolvedValue(subs),
      action: vi.fn().mockImplementation(async (_ref: unknown, args: { slot: number }) => {
        const match = subs.find((s) => s.slot === args.slot)
        return await Promise.resolve({
          email: match?.email ?? '?',
          slot: args.slot,
          plaintextBlob: SAMPLE_LOCAL_BLOB,
          contentHash: 'hash-x',
          action: 'inSync',
          expiresAt: 1_900_000_000_000,
          lastRefreshedAt: Date.now(),
        })
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    await runRefresh({ all: true })

    // listForUser called once + refreshSub called once per sub.
    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.action).toHaveBeenCalledTimes(3)
    const calledSlots = client.action.mock.calls.map((c) => (c[1] as { slot: number }).slot).sort()
    expect(calledSlots).toEqual([1, 2, 3])
  })

  it('prints a per-sub line and a summary for --all', async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    const subs = [
      { _id: 'sub_a', slot: 1, email: 'alice@example.com' },
      { _id: 'sub_b', slot: 2, email: 'bob@example.com' },
    ]
    const client = {
      query: vi.fn().mockResolvedValue(subs),
      action: vi.fn().mockImplementation(async (_ref: unknown, args: { slot: number }) => {
        return await Promise.resolve({
          email: subs.find((s) => s.slot === args.slot)?.email ?? '?',
          slot: args.slot,
          plaintextBlob: SAMPLE_LOCAL_BLOB,
          contentHash: 'hash-x',
          action: args.slot === 1 ? 'refreshedFromAnthropic' : 'inSync',
          expiresAt: 1_900_000_000_000,
          lastRefreshedAt: Date.now(),
        })
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runRefresh({ all: true })

    const out = captured.join('\n')
    // Per-sub progress lines (i/N).
    expect(out).toMatch(/\[1\/2\]/)
    expect(out).toMatch(/\[2\/2\]/)
    expect(out).toContain('alice@example.com')
    expect(out).toContain('bob@example.com')
    // Summary line.
    expect(out.toLowerCase()).toMatch(/summary|2 ok/)
  })

  it('classifies RELOGIN_REQUIRED as needs-attention without throwing the whole batch', async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    const subs = [
      { _id: 'sub_a', slot: 1, email: 'alice@example.com' },
      { _id: 'sub_b', slot: 2, email: 'dead@example.com' },
    ]
    const client = {
      query: vi.fn().mockResolvedValue(subs),
      action: vi.fn().mockImplementation(async (_ref: unknown, args: { slot: number }) => {
        if (args.slot === 2) {
          throw new Error('[Server Error] RELOGIN_REQUIRED: refresh token revoked')
        }
        return await Promise.resolve({
          email: 'alice@example.com',
          slot: 1,
          plaintextBlob: SAMPLE_LOCAL_BLOB,
          contentHash: 'hash-x',
          action: 'inSync',
          expiresAt: 1_900_000_000_000,
          lastRefreshedAt: Date.now(),
        })
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    // --all swallows per-sub failures into the summary; it doesn't
    // throw. Exit code must be set for a non-empty failure set, but
    // the function itself returns; the caller (citty) reads
    // `process.exitCode` for that.
    process.exitCode = 0
    await runRefresh({ all: true })
    const out = captured.join('\n')
    expect(out).toMatch(/relogin|attention/i)
    expect(out).toContain('dead@example.com')
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('--all + a single failure leaves process.exitCode=1', async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    const subs = [{ _id: 'sub_a', slot: 1, email: 'alice@example.com' }]
    const client = {
      query: vi.fn().mockResolvedValue(subs),
      action: vi.fn().mockRejectedValue(new Error('Network unreachable')),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    process.exitCode = 0
    await runRefresh({ all: true })
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('--all + everything in sync leaves process.exitCode=0', async () => {
    vi.mocked(readCredentials).mockReturnValue(SAMPLE_LOCAL_BLOB)
    const subs = [{ _id: 'sub_a', slot: 1, email: 'alice@example.com' }]
    const client = {
      query: vi.fn().mockResolvedValue(subs),
      action: vi.fn().mockResolvedValue({
        email: 'alice@example.com',
        slot: 1,
        plaintextBlob: SAMPLE_LOCAL_BLOB,
        contentHash: 'hash-x',
        action: 'inSync',
        expiresAt: 1_900_000_000_000,
        lastRefreshedAt: Date.now(),
      }),
    }
    vi.mocked(makeVaultClient).mockResolvedValueOnce({
      ...client,
      withMachineLabel: noopWithMachineLabel,
      withSessionId: noopWithSessionId,
      withMeta: noopWithMeta,
    } as never)

    process.exitCode = 0
    await runRefresh({ all: true })
    expect(process.exitCode).toBe(0)
  })
})
