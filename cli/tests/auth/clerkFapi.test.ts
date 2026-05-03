/**
 * Spec: §7 + clerk-convex-tanstack-integration.md §4-5.
 *
 * The CLI exchanges a one-time sign-in token (delivered by the dashboard
 * via the localhost callback) for a Clerk session, then mints a
 * Convex-template JWT against Clerk FAPI. We control the FAPI endpoints
 * tested here by stubbing `fetch`.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  ClerkSessionExpiredError,
  cliUserAgent,
  decodeJwtExp,
  exchangeTicketForSession,
  mintConvexJwt,
} from '../../src/auth/clerkFapi'
import type { SessionState } from '../../src/auth/session'

const FRONTEND_API_URL = 'https://clear-redbird-6.clerk.accounts.dev'
const CONVEX_URL = 'https://beloved-mouse-707.convex.cloud'

/** Build a JWT-shaped string with a given `exp` claim. The signature is fake. */
function buildFakeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
  return `${header}.${payload}.fake-signature`
}

function fetchOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fetchErr(text: string, status: number): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } })
}

function baseSession(): SessionState {
  return {
    version: 1,
    clerkSessionId: 'sess_test123',
    clerkSessionToken: 'session-jwt-blob',
    convexJwt: 'old-convex-jwt',
    convexJwtExpiry: 0,
    frontendApiUrl: FRONTEND_API_URL,
    convexUrl: CONVEX_URL,
    issuedAt: 1_700_000_000,
  }
}

describe('cliUserAgent', () => {
  it('includes the cvault-cli prefix and platform info', () => {
    const ua = cliUserAgent()
    expect(ua).toMatch(/^cvault-cli\//)
    expect(ua).toContain(process.platform)
    expect(ua).toContain(process.arch)
  })
})

describe('decodeJwtExp', () => {
  it('extracts `exp` from a base64url-encoded JWT payload', () => {
    const jwt = buildFakeJwt(1_800_000_000)
    expect(decodeJwtExp(jwt)).toBe(1_800_000_000)
  })

  it('throws on a malformed JWT', () => {
    expect(() => decodeJwtExp('not.a.jwt-because-the-middle-is-not-base64url')).toThrow()
  })
})

describe('mintConvexJwt', () => {
  // The mint endpoint is the Convex HTTP action `/api/cli/mint-token`,
  // served from the `.convex.site` host derived from `convexUrl` (which
  // points at `.convex.cloud`). See the comment in `mintConvexJwt` for why
  // we no longer call FAPI's session-template endpoint directly.
  const MINT_URL = `${CONVEX_URL.replace(/\.convex\.cloud$/, '.convex.site')}/api/cli/mint-token`

  it('returns the jwt + exp on a 200 response', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    const jwt = buildFakeJwt(exp)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fetchOk({ jwt }))

    const result = await mintConvexJwt(baseSession())
    expect(result.convexJwt).toBe(jwt)
    expect(result.convexJwtExpiry).toBe(exp)

    expect(fetchSpy).toHaveBeenCalledWith(
      MINT_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }) as Record<string, string>,
        body: JSON.stringify({ clerkSessionToken: 'session-jwt-blob' }),
      })
    )
  })

  it('throws ClerkSessionExpiredError on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fetchErr('unauthorized', 401))
    await expect(mintConvexJwt(baseSession())).rejects.toBeInstanceOf(ClerkSessionExpiredError)
  })

  it('throws ClerkSessionExpiredError on 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fetchErr('forbidden', 403))
    await expect(mintConvexJwt(baseSession())).rejects.toBeInstanceOf(ClerkSessionExpiredError)
  })

  it('throws ClerkSessionExpiredError on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fetchErr('not found', 404))
    await expect(mintConvexJwt(baseSession())).rejects.toBeInstanceOf(ClerkSessionExpiredError)
  })

  it('throws a generic Error on other non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fetchErr('boom', 500))
    await expect(mintConvexJwt(baseSession())).rejects.toThrow(/500/)
  })
})

describe('exchangeTicketForSession', () => {
  it('exchanges a ticket via FAPI and immediately mints a Convex JWT', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    const jwt = buildFakeJwt(exp)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        fetchOk({
          client: {
            last_active_session_id: 'sess_xyz',
            sessions: [
              {
                id: 'sess_xyz',
                last_active_token: { jwt: 'long-lived-session-jwt' },
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(fetchOk({ jwt }))

    const result = await exchangeTicketForSession({
      signInToken: 'sit_abc',
      frontendApiUrl: FRONTEND_API_URL,
      convexUrl: CONVEX_URL,
    })

    expect(result.clerkSessionId).toBe('sess_xyz')
    expect(result.clerkSessionToken).toBe('long-lived-session-jwt')
    expect(result.convexJwt).toBe(jwt)
    expect(result.convexJwtExpiry).toBe(exp)
    expect(result.frontendApiUrl).toBe(FRONTEND_API_URL)
    expect(result.convexUrl).toBe(CONVEX_URL)

    // First call: POST /v1/client/sign_ins with strategy=ticket
    const firstCall = fetchSpy.mock.calls[0]
    expect(firstCall?.[0]).toBe(`${FRONTEND_API_URL}/v1/client/sign_ins`)
    const firstInit = firstCall?.[1]
    expect(firstInit?.method).toBe('POST')
    expect(typeof firstInit?.body).toBe('string')
    // Body is a urlencoded string; parse + assert each param.
    const bodyStr = typeof firstInit?.body === 'string' ? firstInit.body : ''
    const params = new URLSearchParams(bodyStr)
    expect(params.get('strategy')).toBe('ticket')
    expect(params.get('ticket')).toBe('sit_abc')
  })

  it('passes Origin header when dashboardOrigin is provided', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        fetchOk({
          client: {
            last_active_session_id: 'sess_a',
            sessions: [{ id: 'sess_a', last_active_token: { jwt: 'tok' } }],
          },
        })
      )
      .mockResolvedValueOnce(fetchOk({ jwt: buildFakeJwt(2_000_000_000) }))

    await exchangeTicketForSession({
      signInToken: 'sit_a',
      frontendApiUrl: FRONTEND_API_URL,
      convexUrl: CONVEX_URL,
      dashboardOrigin: 'https://app.cvault.dev',
    })

    const init = fetchSpy.mock.calls[0]?.[1]
    const headers = init?.headers as Record<string, string> | undefined
    expect(headers?.Origin).toBe('https://app.cvault.dev')
  })

  it('throws when FAPI sign_in returns non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fetchErr('bad ticket', 400))
    await expect(
      exchangeTicketForSession({
        signInToken: 'sit_bad',
        frontendApiUrl: FRONTEND_API_URL,
        convexUrl: CONVEX_URL,
      })
    ).rejects.toThrow(/sign_in.*400/)
  })

  it('throws when the response body lacks a session token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({ client: { last_active_session_id: 'sess_x', sessions: [] } })
    )
    await expect(
      exchangeTicketForSession({
        signInToken: 'sit_x',
        frontendApiUrl: FRONTEND_API_URL,
        convexUrl: CONVEX_URL,
      })
    ).rejects.toThrow(/usable session token/i)
  })
})
