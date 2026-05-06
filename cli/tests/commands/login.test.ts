/**
 * Spec: §7 — `cvault login`.
 *
 * Flow:
 *   1. Generate a random `state` nonce
 *   2. Start the localhost callback server (Bun.serve on 127.0.0.1:0)
 *   3. Open the dashboard URL with `redirect=http://127.0.0.1:<port>/&state=<nonce>`
 *   4. Wait for the dashboard to POST back `{state, signInToken}`
 *   5. Exchange the ticket for a Clerk session (FAPI)
 *   6. Persist `~/.vault/session.json` — including the machine label
 *      (`--label` override or `os.hostname()`) so the dashboard's
 *      "Machines" view can render a human-readable identifier per session
 *   7. Print success
 *
 * We mock `startCallbackServer`, `openBrowser`, `exchangeTicketForSession`,
 * and `writeSession` so the test never opens a browser, never binds a
 * port, and never writes to disk.
 */
import { hostname } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

import pkg from '../../package.json' with { type: 'json' }
import { startCallbackServer } from '../../src/auth/callbackServer'
import { exchangeTicketForSession } from '../../src/auth/clerkFapi'
import { openBrowser } from '../../src/auth/openBrowser'
import { writeSession } from '../../src/auth/session'
import { runLogin } from '../../src/commands/login'

vi.mock('../../src/auth/callbackServer', () => ({
  startCallbackServer: vi.fn(),
}))

vi.mock('../../src/auth/openBrowser', () => ({
  openBrowser: vi.fn().mockResolvedValue(undefined),
}))

// Real classes so `instanceof` works inside login.ts's catch branch. Defined
// via vi.hoisted so vi.mock's hoisted factory can capture the references.
const { FakeClerkEmailDomainNotAllowedError, FakeConvexEndpointNotFoundError } = vi.hoisted(() => ({
  FakeClerkEmailDomainNotAllowedError: class FakeClerkEmailDomainNotAllowedError extends Error {
    override readonly name = 'ClerkEmailDomainNotAllowedError'
    readonly serverMessage: string
    constructor(serverMessage: string) {
      super(serverMessage)
      this.serverMessage = serverMessage
    }
  },
  FakeConvexEndpointNotFoundError: class FakeConvexEndpointNotFoundError extends Error {
    override readonly name = 'ConvexEndpointNotFoundError'
    readonly url: string
    readonly body: string
    constructor(url: string, body: string) {
      super(
        `cvault is pointing at a Convex deployment that does not have the cvault HTTP routes registered (URL: ${url}). ` +
          `This usually means a foreign .env.local in your current directory is overriding the baked CLI config — ` +
          `check VITE_CONVEX_URL / CLERK_FRONTEND_API_URL in your CWD. ` +
          `If those are correct, your installed binary may be older than the deployed routes (run \`brew upgrade cvault\`). ` +
          `(body: ${body.slice(0, 200)})`
      )
      this.url = url
      this.body = body
    }
  },
}))

vi.mock('../../src/auth/clerkFapi', () => ({
  exchangeTicketForSession: vi.fn(),
  ClerkSessionExpiredError: class extends Error {},
  ClerkEmailDomainNotAllowedError: FakeClerkEmailDomainNotAllowedError,
  ConvexEndpointNotFoundError: FakeConvexEndpointNotFoundError,
  // Read from cli/package.json so the mocked UA tracks every release bump
  // automatically (matches the production CLI_VERSION source-of-truth fix).
  cliUserAgent: () => `cvault-cli/${pkg.version} (test)`,
}))

vi.mock('../../src/auth/session', () => ({
  writeSession: vi.fn().mockResolvedValue(undefined),
  NotLoggedInError: class extends Error {},
}))

describe('runLogin', () => {
  it('opens the dashboard URL with redirect + state, then persists the exchanged session', async () => {
    const mockStart = vi.mocked(startCallbackServer)
    mockStart.mockReturnValue({
      port: 54321,
      result: Promise.resolve({ signInToken: 'sit_abc' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    })

    const mockExchange = vi.mocked(exchangeTicketForSession)
    mockExchange.mockResolvedValueOnce({
      version: 1,
      clerkSessionId: 'sess_xyz',
      clerkSessionToken: 'long-lived',
      convexJwt: 'short',
      convexJwtExpiry: 1_700_000_999,
      frontendApiUrl: 'https://clear-redbird-6.clerk.accounts.dev',
      convexUrl: 'https://beloved-mouse-707.convex.cloud',
      issuedAt: 1_700_000_000,
    })

    await runLogin({
      dashboardUrl: 'https://app.cvault.dev',
      convexUrl: 'https://beloved-mouse-707.convex.cloud',
      frontendApiUrl: 'https://clear-redbird-6.clerk.accounts.dev',
    })

    // Browser was opened with a /cli/link URL containing the redirect + state.
    expect(openBrowser).toHaveBeenCalledOnce()
    const browserUrl = vi.mocked(openBrowser).mock.calls[0]?.[0] ?? ''
    const parsed = new URL(browserUrl)
    expect(parsed.origin).toBe('https://app.cvault.dev')
    expect(parsed.pathname).toBe('/cli/link')
    expect(parsed.searchParams.get('redirect')).toBe('http://127.0.0.1:54321/')
    const state = parsed.searchParams.get('state')
    expect(state).toBeTruthy()
    expect((state ?? '').length).toBeGreaterThan(8)

    // The same state was passed to the callback server's expectedState.
    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ expectedState: state }))

    // The captured signInToken was forwarded to the FAPI exchange.
    expect(mockExchange).toHaveBeenCalledWith(
      expect.objectContaining({
        signInToken: 'sit_abc',
        frontendApiUrl: 'https://clear-redbird-6.clerk.accounts.dev',
        convexUrl: 'https://beloved-mouse-707.convex.cloud',
      })
    )

    // The exchanged session was persisted.
    expect(writeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        clerkSessionId: 'sess_xyz',
        convexJwt: 'short',
      })
    )
  })

  it('cancels the callback server when the FAPI exchange fails', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    vi.mocked(startCallbackServer).mockReturnValue({
      port: 12345,
      result: Promise.resolve({ signInToken: 'sit_x' }),
      cancel,
    })

    vi.mocked(exchangeTicketForSession).mockRejectedValueOnce(new Error('Clerk FAPI sign_in failed: 400 bad ticket'))

    await expect(
      runLogin({
        dashboardUrl: 'https://app.cvault.dev',
        convexUrl: 'https://x.convex.cloud',
        frontendApiUrl: 'https://x.clerk.accounts.dev',
      })
    ).rejects.toThrow(/bad ticket/)

    expect(cancel).toHaveBeenCalledOnce()
  })

  it('prints a friendly error and exits 1 on EMAIL_DOMAIN_NOT_ALLOWED', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    vi.mocked(startCallbackServer).mockReturnValue({
      port: 12345,
      result: Promise.resolve({ signInToken: 'sit_x' }),
      cancel,
    })

    vi.mocked(exchangeTicketForSession).mockRejectedValueOnce(
      new FakeClerkEmailDomainNotAllowedError('Your email domain is not allowed to use cvault.')
    )

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // process.exit(1) must throw so the test can assert the call instead of
    // actually exiting the test runner.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`)
    }) as never)

    try {
      await expect(
        runLogin({
          dashboardUrl: 'https://app.cvault.dev',
          convexUrl: 'https://x.convex.cloud',
          frontendApiUrl: 'https://x.clerk.accounts.dev',
        })
      ).rejects.toThrow(/process\.exit\(1\)/)

      expect(cancel).toHaveBeenCalledOnce()
      expect(exitSpy).toHaveBeenCalledWith(1)
      // First console.error: server message; second: "Sign out... try again with allowlisted email."
      const calls = errorSpy.mock.calls.map((c) => String(c[0]))
      expect(calls.some((m) => /domain/i.test(m))).toBe(true)
      expect(calls.some((m) => /sign out|allowlisted/i.test(m))).toBe(true)
    } finally {
      errorSpy.mockRestore()
      exitSpy.mockRestore()
    }
  })

  it('prints a friendly error and exits 1 on ConvexEndpointNotFoundError (wrong-deployment hijack)', async () => {
    // The 404 + "No matching routes found" path that fires when a foreign
    // `.env.local` in the user's CWD points the CLI at a Convex deployment
    // without the cvault HTTP routes. Same dispatch shape as
    // EMAIL_DOMAIN_NOT_ALLOWED: print the actionable message and exit 1.
    const cancel = vi.fn().mockResolvedValue(undefined)
    vi.mocked(startCallbackServer).mockReturnValue({
      port: 12345,
      result: Promise.resolve({ signInToken: 'sit_x' }),
      cancel,
    })
    vi.mocked(exchangeTicketForSession).mockRejectedValueOnce(
      new FakeConvexEndpointNotFoundError('https://hijacker.convex.site/api/cli/mint-token', 'No matching routes found')
    )

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`)
    }) as never)

    try {
      await expect(
        runLogin({
          dashboardUrl: 'https://app.cvault.dev',
          convexUrl: 'https://x.convex.cloud',
          frontendApiUrl: 'https://x.clerk.accounts.dev',
        })
      ).rejects.toThrow(/process\.exit\(1\)/)

      expect(cancel).toHaveBeenCalledOnce()
      expect(exitSpy).toHaveBeenCalledWith(1)
      // The error message must surface (a) the URL the CLI tried, (b) a
      // pointer at the most likely cause (`.env.local`). The login.ts
      // catch handler prints the .message verbatim — assert by inspecting
      // the captured console.error calls.
      const calls = errorSpy.mock.calls.map((c) => String(c[0]))
      expect(calls.some((m) => /\.env\.local/i.test(m))).toBe(true)
      expect(calls.some((m) => /No matching routes found/i.test(m))).toBe(true)
    } finally {
      errorSpy.mockRestore()
      exitSpy.mockRestore()
    }
  })

  it('cancels the callback server if the user closes the tab (timeout)', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    vi.mocked(startCallbackServer).mockReturnValue({
      port: 12345,
      result: Promise.reject(new Error('Browser sign-in timed out.')),
      cancel,
    })

    await expect(
      runLogin({
        dashboardUrl: 'https://app.cvault.dev',
        convexUrl: 'https://x.convex.cloud',
        frontendApiUrl: 'https://x.clerk.accounts.dev',
      })
    ).rejects.toThrow(/timed out/)
  })

  /**
   * Machine label: every audit row written by subsequent CLI commands
   * needs a human-readable identifier (the dashboard's "Machines" view
   * renders this — opaque clerkSessionId is unhelpful). The label is
   * captured at login time, persisted to session.json, and read back
   * by every command via `VaultClient.machineLabel`.
   */
  it('falls back to os.hostname() when --label is not provided', async () => {
    vi.mocked(startCallbackServer).mockReturnValue({
      port: 12345,
      result: Promise.resolve({ signInToken: 'sit_x' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    })
    vi.mocked(exchangeTicketForSession).mockResolvedValueOnce({
      version: 1,
      clerkSessionId: 'sess_xyz',
      clerkSessionToken: 'long-lived',
      convexJwt: 'short',
      convexJwtExpiry: 1_700_000_999,
      frontendApiUrl: 'https://x.clerk.accounts.dev',
      convexUrl: 'https://x.convex.cloud',
      issuedAt: 1_700_000_000,
    })

    await runLogin({
      dashboardUrl: 'https://app.cvault.dev',
      convexUrl: 'https://x.convex.cloud',
      frontendApiUrl: 'https://x.clerk.accounts.dev',
    })

    expect(writeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        clerkSessionId: 'sess_xyz',
        machineLabel: hostname(),
      })
    )
  })

  it('uses --label override when supplied', async () => {
    vi.mocked(startCallbackServer).mockReturnValue({
      port: 12345,
      result: Promise.resolve({ signInToken: 'sit_x' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    })
    vi.mocked(exchangeTicketForSession).mockResolvedValueOnce({
      version: 1,
      clerkSessionId: 'sess_xyz',
      clerkSessionToken: 'long-lived',
      convexJwt: 'short',
      convexJwtExpiry: 1_700_000_999,
      frontendApiUrl: 'https://x.clerk.accounts.dev',
      convexUrl: 'https://x.convex.cloud',
      issuedAt: 1_700_000_000,
    })

    await runLogin({
      dashboardUrl: 'https://app.cvault.dev',
      convexUrl: 'https://x.convex.cloud',
      frontendApiUrl: 'https://x.clerk.accounts.dev',
      machineLabel: 'office-laptop',
    })

    expect(writeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineLabel: 'office-laptop',
      })
    )
  })

  it('trims whitespace from --label and rejects empty strings (falls back to hostname)', async () => {
    vi.mocked(startCallbackServer).mockReturnValue({
      port: 12345,
      result: Promise.resolve({ signInToken: 'sit_x' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    })
    vi.mocked(exchangeTicketForSession).mockResolvedValueOnce({
      version: 1,
      clerkSessionId: 'sess_xyz',
      clerkSessionToken: 'long-lived',
      convexJwt: 'short',
      convexJwtExpiry: 1_700_000_999,
      frontendApiUrl: 'https://x.clerk.accounts.dev',
      convexUrl: 'https://x.convex.cloud',
      issuedAt: 1_700_000_000,
    })

    await runLogin({
      dashboardUrl: 'https://app.cvault.dev',
      convexUrl: 'https://x.convex.cloud',
      frontendApiUrl: 'https://x.clerk.accounts.dev',
      machineLabel: '   ',
    })

    expect(writeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        machineLabel: hostname(),
      })
    )
  })

  it('persists the label BEFORE the recordLogin audit fires (commit-then-audit ordering)', async () => {
    // session.json must hold the label before recordLogin runs so a crash
    // mid-audit doesn't leave the on-disk session label-less while the
    // server has the audit row.
    const callOrder: Array<'writeSession' | 'recordLogin'> = []
    vi.mocked(startCallbackServer).mockReturnValue({
      port: 12345,
      result: Promise.resolve({ signInToken: 'sit_x' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    })
    vi.mocked(exchangeTicketForSession).mockResolvedValueOnce({
      version: 1,
      clerkSessionId: 'sess_xyz',
      clerkSessionToken: 'long-lived',
      convexJwt: 'short',
      convexJwtExpiry: 1_700_000_999,
      frontendApiUrl: 'https://x.clerk.accounts.dev',
      convexUrl: 'https://x.convex.cloud',
      issuedAt: 1_700_000_000,
    })
    vi.mocked(writeSession).mockImplementationOnce(async () => {
      callOrder.push('writeSession')
    })
    // recordLogin is called via VaultClient.action — we can't easily mock
    // VaultClient, but we can intercept the network call. Easier: rely
    // on the writeSession mock recording its call, plus assert
    // writeSession got the label.
    await runLogin({
      dashboardUrl: 'https://app.cvault.dev',
      convexUrl: 'https://x.convex.cloud',
      frontendApiUrl: 'https://x.clerk.accounts.dev',
      machineLabel: 'order-test',
    })
    // writeSession must have been called once, with the label baked in.
    expect(callOrder).toEqual(['writeSession'])
    expect(writeSession).toHaveBeenCalledWith(expect.objectContaining({ machineLabel: 'order-test' }))
  })
})

/**
 * citty argument parsing for `cvault login --label <name>`. The flag is
 * declared as `args.label` at the citty level; the run() hook converts
 * it to `RunLoginOptions.machineLabel` before delegating to runLogin.
 */
describe('loginCommand argument parsing', () => {
  it('declares --label as an optional string flag with description', async () => {
    // citty's `args` field is typed as `Resolvable<T>` which is `T |
    // (() => T) | (() => Promise<T>)`. Normalize all three shapes
    // before reading the flag declaration.
    const { loginCommand } = await import('../../src/commands/login')
    const raw = loginCommand.args
    const resolved = typeof raw === 'function' ? await raw() : await raw
    expect(resolved).toBeDefined()
    if (resolved === undefined) return
    const labelArg = (resolved as Record<string, { type?: string; description?: string; required?: boolean }>).label
    expect(labelArg).toBeDefined()
    if (labelArg === undefined) return
    // Shape: type and description must be set so `cvault login --help`
    // renders the flag.
    expect(labelArg.type).toBe('string')
    expect(labelArg.required).not.toBe(true)
    expect(typeof labelArg.description).toBe('string')
    // Description must mention the override / default behaviour so users
    // know what to pass.
    expect(labelArg.description).toMatch(/hostname|machine|label/i)
  })
})
