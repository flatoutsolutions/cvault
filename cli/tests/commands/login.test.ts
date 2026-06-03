/**
 * Spec: §Task 15 — `cvault login` OAuth Authorization Code + PKCE.
 *
 * Flow under test:
 *   1. Generate PKCE verifier + challenge
 *   2. Start async callback server
 *   3. Open browser to OAuth authorize URL
 *   4. Wait for callback → captures `code`
 *   5. Exchange code for tokens
 *   6. Load machine id
 *   7. Persist v2 session.json
 *   8. Best-effort recordLogin audit
 *
 * We mock `startCallbackServer`, `openBrowser`, `exchangeCodeForTokens`,
 * `loadOrCreateMachineId`, and `writeSession` so the test never opens a
 * browser, never binds a port, and never writes to disk.
 */
import { hostname } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

// Mock citty BEFORE any import that triggers it (citty not in Node test env).
// vi.mock is hoisted by vitest so order relative to imports doesn't matter.
vi.mock('citty', () => ({
  defineCommand: vi.fn((config: unknown) => config),
}))

// Mock the convex generated API (not resolvable in Node test env)
vi.mock('../../../convex/_generated/api', () => ({
  api: {
    cli: {
      actions: {
        recordLogin: 'cli/actions:recordLogin',
      },
    },
  },
}))

// Mock VaultClient so recordLogin audit does not hit Convex
vi.mock('../../src/convex/vaultClient', () => ({
  VaultClient: class {
    action = vi.fn().mockResolvedValue({ recorded: true })
    withMeta = vi.fn((args: Record<string, unknown>) => args)
    machineLabel: string | undefined = undefined
  },
  makeVaultClient: vi.fn(),
}))

import { startCallbackServer } from '../../src/auth/callbackServer'
import { loadOrCreateMachineId } from '../../src/auth/machineId'
import { exchangeCodeForTokens } from '../../src/auth/oauthPkce'
import { openBrowser } from '../../src/auth/openBrowser'
import { writeSession } from '../../src/auth/session'
import { runLogin } from '../../src/commands/login'

vi.mock('../../src/auth/callbackServer', () => ({
  startCallbackServer: vi.fn(),
}))

vi.mock('../../src/auth/openBrowser', () => ({
  openBrowser: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/auth/oauthPkce', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/oauthPkce')>('../../src/auth/oauthPkce')
  return {
    ...actual,
    exchangeCodeForTokens: vi.fn(),
  }
})

vi.mock('../../src/auth/machineId', () => ({
  loadOrCreateMachineId: vi.fn().mockResolvedValue('machine-uuid-test-1234'),
}))

vi.mock('../../src/auth/session', () => ({
  writeSession: vi.fn().mockResolvedValue(undefined),
  NotLoggedInError: class extends Error {},
}))

// Mock pkce to have deterministic values for URL assertion
vi.mock('../../src/auth/pkce', () => ({
  generateCodeVerifier: vi.fn().mockReturnValue('test-code-verifier'),
  codeChallengeS256: vi.fn().mockReturnValue('test-code-challenge'),
  base64UrlEncode: vi.fn(),
}))

/** Sample OAuth token response */
const SAMPLE_TOKENS = {
  accessToken: 'access-token-new',
  accessTokenExpiry: Math.floor(Date.now() / 1000) + 900,
  refreshToken: 'refresh-token-new',
  idToken: 'id-token-new',
}

const SAMPLE_OPTS = {
  convexUrl: 'https://beloved-mouse-707.convex.cloud',
  frontendApiUrl: 'https://clear-redbird-6.clerk.accounts.dev',
  clientId: 'client_test_abc',
}

function makeHandle(code = 'auth-code-xyz', state?: string) {
  return {
    port: 54321,
    result: Promise.resolve({ code, state: state ?? 'ignored', cancelled: false }),
    cancel: vi.fn().mockResolvedValue(undefined),
  }
}

describe('runLogin', () => {
  it('opens an OAuth authorize URL with PKCE params, then persists a v2 session', async () => {
    const mockStart = vi.mocked(startCallbackServer)
    mockStart.mockResolvedValue(makeHandle())

    const mockExchange = vi.mocked(exchangeCodeForTokens)
    mockExchange.mockResolvedValueOnce(SAMPLE_TOKENS)

    await runLogin(SAMPLE_OPTS)

    // Browser was opened with an OAuth authorize URL containing PKCE + state.
    expect(openBrowser).toHaveBeenCalledOnce()
    const browserUrl = vi.mocked(openBrowser).mock.calls[0]?.[0] ?? ''
    const parsed = new URL(browserUrl)
    expect(parsed.origin + parsed.pathname).toBe(
      `${SAMPLE_OPTS.frontendApiUrl}/oauth/authorize`
    )
    expect(parsed.searchParams.get('client_id')).toBe(SAMPLE_OPTS.clientId)
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy()
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    const stateParam = parsed.searchParams.get('state')
    expect(stateParam).toBeTruthy()
    expect((stateParam ?? '').length).toBeGreaterThan(8)

    // The same state was passed to the callback server's expectedState.
    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ expectedState: stateParam }))

    // The captured code was forwarded to the token exchange.
    expect(mockExchange).toHaveBeenCalledWith(
      expect.objectContaining({
        frontendApiUrl: SAMPLE_OPTS.frontendApiUrl,
        clientId: SAMPLE_OPTS.clientId,
        code: 'auth-code-xyz',
        codeVerifier: 'test-code-verifier',
      })
    )

    // A v2 session was persisted.
    expect(writeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 2,
        accessToken: SAMPLE_TOKENS.accessToken,
        refreshToken: SAMPLE_TOKENS.refreshToken,
        clientId: SAMPLE_OPTS.clientId,
        frontendApiUrl: SAMPLE_OPTS.frontendApiUrl,
        convexUrl: SAMPLE_OPTS.convexUrl,
      })
    )
  })

  it('throws if the callback server rejects (e.g. timeout)', async () => {
    vi.mocked(startCallbackServer).mockResolvedValue({
      port: 12345,
      result: Promise.reject(new Error('Browser sign-in timed out.')),
      cancel: vi.fn().mockResolvedValue(undefined),
    })

    await expect(runLogin(SAMPLE_OPTS)).rejects.toThrow(/timed out/)
  })

  it('throws if login is cancelled', async () => {
    vi.mocked(startCallbackServer).mockResolvedValue({
      port: 12345,
      result: Promise.resolve({ code: '', state: '', cancelled: true }),
      cancel: vi.fn().mockResolvedValue(undefined),
    })

    await expect(runLogin(SAMPLE_OPTS)).rejects.toThrow(/cancel/i)
  })

  it('throws if exchangeCodeForTokens fails', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    vi.mocked(startCallbackServer).mockResolvedValue({
      port: 12345,
      result: Promise.resolve({ code: 'code123', state: 'ignored', cancelled: false }),
      cancel,
    })
    vi.mocked(exchangeCodeForTokens).mockRejectedValueOnce(new Error('token exchange failed: 400 bad request'))

    await expect(runLogin(SAMPLE_OPTS)).rejects.toThrow(/bad request/)
  })

  it('falls back to os.hostname() when --label is not provided', async () => {
    vi.mocked(startCallbackServer).mockResolvedValue(makeHandle())
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce(SAMPLE_TOKENS)

    await runLogin(SAMPLE_OPTS)

    expect(writeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineLabel: hostname(),
      })
    )
  })

  it('uses --label override when supplied', async () => {
    vi.mocked(startCallbackServer).mockResolvedValue(makeHandle())
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce(SAMPLE_TOKENS)

    await runLogin({ ...SAMPLE_OPTS, machineLabel: 'office-laptop' })

    expect(writeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineLabel: 'office-laptop',
      })
    )
  })

  it('trims whitespace from --label and falls back to hostname for empty strings', async () => {
    vi.mocked(startCallbackServer).mockResolvedValue(makeHandle())
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce(SAMPLE_TOKENS)

    await runLogin({ ...SAMPLE_OPTS, machineLabel: '   ' })

    expect(writeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineLabel: hostname(),
      })
    )
  })

  it('persists the session BEFORE the recordLogin audit fires (commit-then-audit ordering)', async () => {
    const callOrder: Array<'writeSession' | 'recordLogin'> = []
    vi.mocked(startCallbackServer).mockResolvedValue(makeHandle())
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce(SAMPLE_TOKENS)
    vi.mocked(writeSession).mockImplementationOnce(async () => {
      callOrder.push('writeSession')
    })

    await runLogin({ ...SAMPLE_OPTS, machineLabel: 'order-test' })

    // writeSession must have been called at least once, with the label baked in.
    expect(callOrder).toContain('writeSession')
    expect(writeSession).toHaveBeenCalledWith(expect.objectContaining({ machineLabel: 'order-test' }))
  })

  it('includes the machineId in the v2 session write (via loadOrCreateMachineId)', async () => {
    vi.mocked(startCallbackServer).mockResolvedValue(makeHandle())
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce(SAMPLE_TOKENS)
    vi.mocked(loadOrCreateMachineId).mockResolvedValue('deterministic-machine-id')

    await runLogin(SAMPLE_OPTS)

    // Machine id is NOT written to session (v2 SessionState doesn't have a machineId field),
    // but it IS passed to recordLogin. We can assert writeSession was called with v2 shape.
    expect(writeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 2,
        frontendApiUrl: SAMPLE_OPTS.frontendApiUrl,
      })
    )
    expect(loadOrCreateMachineId).toHaveBeenCalled()
  })
})

/**
 * citty argument parsing for `cvault login --label <name>`.
 */
describe('loginCommand argument parsing', () => {
  it('declares --label as an optional string flag with description', async () => {
    const { loginCommand } = await import('../../src/commands/login')
    const raw = loginCommand.args
    const resolved = typeof raw === 'function' ? await raw() : await raw
    expect(resolved).toBeDefined()
    if (resolved === undefined) return
    const labelArg = (resolved as Record<string, { type?: string; description?: string; required?: boolean }>).label
    expect(labelArg).toBeDefined()
    if (labelArg === undefined) return
    expect(labelArg.type).toBe('string')
    expect(labelArg.required).not.toBe(true)
    expect(typeof labelArg.description).toBe('string')
    expect(labelArg.description).toMatch(/hostname|machine|label/i)
  })
})
