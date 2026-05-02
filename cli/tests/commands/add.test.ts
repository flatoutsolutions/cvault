/**
 * Spec: §7 — `cvault add`.
 *
 * Flow:
 *   0. Detect any pre-existing active account; prompt for confirmation
 *      before overwriting (unless `--force` is passed).
 *   1. Spawn `claude` (the Claude Code CLI) interactively for OAuth.
 *   2. Read the new credentials + `~/.claude.json` to capture the envelope.
 *   3. POST plaintext to Convex via
 *      `api.subscriptions.actions.upsertFromPlaintext`.
 *
 * We mock the `credentials` module + the VaultClient so the test never
 * spawns a subprocess and never hits Convex.
 */
import { Readable, Writable } from 'node:stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runAdd } from '../../src/commands/add'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { addAccountInteractive, exportAccount, getActiveAccount } from '../../src/credentials'
import { singleAccountEnvelope } from '../fixtures/envelopes/singleAccount'

vi.mock('../../src/credentials', () => ({
  addAccountInteractive: vi.fn().mockResolvedValue(undefined),
  exportAccount: vi.fn(),
  getActiveAccount: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

beforeEach(() => {
  vi.mocked(getActiveAccount).mockReset()
  vi.mocked(addAccountInteractive).mockReset()
  vi.mocked(addAccountInteractive).mockResolvedValue(undefined)
  vi.mocked(exportAccount).mockReset()
  vi.mocked(makeVaultClient).mockReset()
})

interface FakeClient {
  action: ReturnType<typeof vi.fn>
}

function fakeVaultClient(): FakeClient {
  return {
    action: vi.fn().mockResolvedValue({ subId: 'sub_123', slot: 1, created: true }),
  }
}

/**
 * Build minimal stdin/stdout streams so we can exercise the y/N prompt
 * without touching the real TTY. Mirrors the helper in
 * `tests/commands/clean.test.ts`.
 */
function fakeIo(answer: string): { input: Readable; output: Writable } {
  const input = Readable.from([`${answer}\n`])
  const output = new Writable({
    write(_chunk, _enc, cb) {
      cb()
    },
  })
  return { input, output }
}

describe('runAdd — happy path', () => {
  it('runs the OAuth spawn, builds the envelope, and uploads to Convex', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce(null) // no overwrite prompt
    const env = singleAccountEnvelope({ number: 1, email: 'new@example.com' })
    vi.mocked(exportAccount).mockReturnValueOnce(env)
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runAdd({ label: 'work-mac' })

    expect(addAccountInteractive).toHaveBeenCalledOnce()
    expect(exportAccount).toHaveBeenCalledOnce()
    expect(client.action).toHaveBeenCalledOnce()
    const callArg = client.action.mock.calls[0]?.[1] as Record<string, unknown>
    expect(callArg.email).toBe('new@example.com')
    expect(typeof callArg.plaintextBlob).toBe('string')
    expect(callArg.subscriptionType).toBe('max')
    expect(callArg.label).toBe('work-mac')
    const parsed = JSON.parse(callArg.plaintextBlob as string) as {
      claudeAiOauth: { accessToken: string }
    }
    expect(parsed.claudeAiOauth.accessToken).toBe('sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA')
  })

  it('omits `label` when not supplied', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)
    vi.mocked(exportAccount).mockReturnValueOnce(singleAccountEnvelope({ number: 1, email: 'a@b.com' }))
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runAdd({})

    const callArg = client.action.mock.calls[0]?.[1] as Record<string, unknown>
    expect(callArg.label).toBeUndefined()
  })

  it('passes the access-token expiry through to Convex (ms epoch)', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)
    const env = singleAccountEnvelope({ number: 2, email: 'x@y.com' })
    env.accounts[0]!.credentials.claudeAiOauth.expiresAt = 1_900_000_000_000
    vi.mocked(exportAccount).mockReturnValueOnce(env)
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runAdd({})

    const callArg = client.action.mock.calls[0]?.[1] as Record<string, unknown>
    expect(callArg.expiresAt).toBe(1_900_000_000_000)
  })
})

describe('runAdd — overwrite prompt (M7)', () => {
  it('prompts when an active account already exists; "y" proceeds', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'existing@example.com' })
    vi.mocked(exportAccount).mockReturnValueOnce(singleAccountEnvelope({ email: 'fresh@example.com' }))
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runAdd({ io: fakeIo('y') })

    expect(addAccountInteractive).toHaveBeenCalledOnce()
    expect(client.action).toHaveBeenCalledOnce()
  })

  it('aborts cleanly when the user answers "n"', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'existing@example.com' })
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runAdd({ io: fakeIo('n') })

    expect(addAccountInteractive).not.toHaveBeenCalled()
    expect(client.action).not.toHaveBeenCalled()
  })

  it('skips the prompt when `force: true`', async () => {
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'existing@example.com' })
    vi.mocked(exportAccount).mockReturnValueOnce(singleAccountEnvelope())
    const client = fakeVaultClient()
    vi.mocked(makeVaultClient).mockResolvedValueOnce(client as never)

    await runAdd({ force: true })

    expect(addAccountInteractive).toHaveBeenCalledOnce()
    expect(client.action).toHaveBeenCalledOnce()
  })
})
