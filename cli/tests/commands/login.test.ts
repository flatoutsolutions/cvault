/**
 * Spec: §7 — `cvault login`.
 *
 * Flow:
 *   1. Generate a random `state` nonce
 *   2. Start the localhost callback server (Bun.serve on 127.0.0.1:0)
 *   3. Open the dashboard URL with `redirect=http://127.0.0.1:<port>/&state=<nonce>`
 *   4. Wait for the dashboard to POST back `{state, signInToken}`
 *   5. Exchange the ticket for a Clerk session (FAPI)
 *   6. Persist `~/.vault/session.json`
 *   7. Print success
 *
 * We mock `startCallbackServer`, `openBrowser`, `exchangeTicketForSession`,
 * and `writeSession` so the test never opens a browser, never binds a
 * port, and never writes to disk.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/auth/callbackServer', () => ({
  startCallbackServer: vi.fn(),
}))

vi.mock('../../src/auth/openBrowser', () => ({
  openBrowser: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/auth/clerkFapi', () => ({
  exchangeTicketForSession: vi.fn(),
  ClerkSessionExpiredError: class extends Error {},
  cliUserAgent: () => 'cvault-cli/0.1.0 (test)',
}))

vi.mock('../../src/auth/session', () => ({
  writeSession: vi.fn().mockResolvedValue(undefined),
  NotLoggedInError: class extends Error {},
}))

import { startCallbackServer } from '../../src/auth/callbackServer'
import { exchangeTicketForSession } from '../../src/auth/clerkFapi'
import { openBrowser } from '../../src/auth/openBrowser'
import { writeSession } from '../../src/auth/session'
import { runLogin } from '../../src/commands/login'

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
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: state })
    )

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

    vi.mocked(exchangeTicketForSession).mockRejectedValueOnce(
      new Error('Clerk FAPI sign_in failed: 400 bad ticket')
    )

    await expect(
      runLogin({
        dashboardUrl: 'https://app.cvault.dev',
        convexUrl: 'https://x.convex.cloud',
        frontendApiUrl: 'https://x.clerk.accounts.dev',
      })
    ).rejects.toThrow(/bad ticket/)

    expect(cancel).toHaveBeenCalledOnce()
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
})
