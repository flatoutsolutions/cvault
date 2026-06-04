import { describe, expect, it, vi } from 'vitest'

import {
  OAuthRefreshFailedError,
  OAuthTokenExchangeError,
  buildAuthorizeUrl,
  decodeIdTokenSid,
  exchangeCodeForTokens,
  refreshAccessToken,
} from '../../src/auth/oauthPkce'

const FRONTEND = 'https://x.clerk.accounts.dev'

describe('buildAuthorizeUrl', () => {
  it('includes PKCE + scope + state params', () => {
    const url = new URL(
      buildAuthorizeUrl({
        frontendApiUrl: FRONTEND,
        clientId: 'client_1',
        redirectUri: 'http://127.0.0.1:5000/',
        scope: 'openid email profile offline_access',
        codeChallenge: 'abc',
        state: 'nonce',
      })
    )
    expect(url.origin + url.pathname).toBe(`${FRONTEND}/oauth/authorize`)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client_1')
    expect(url.searchParams.get('code_challenge')).toBe('abc')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('nonce')
  })
})

describe('exchangeCodeForTokens', () => {
  it('POSTs form-encoded auth-code grant and maps the response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: header('aud_x'), refresh_token: 'rt', id_token: 'id', expires_in: 900 }),
          { status: 200 }
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    const tokens = await exchangeCodeForTokens({
      frontendApiUrl: FRONTEND,
      clientId: 'client_1',
      code: 'code123',
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1:5000/',
    })
    expect(tokens.refreshToken).toBe('rt')
    expect(tokens.accessTokenExpiry).toBeGreaterThan(0)
    const call = fetchMock.mock.calls[0] as unknown as [string, { body: URLSearchParams }]
    expect(call[1].body.get('grant_type')).toBe('authorization_code')
    expect(call[1].body.get('code_verifier')).toBe('verifier')
  })

  it('throws OAuthTokenExchangeError on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad', { status: 400 }))
    )
    await expect(
      exchangeCodeForTokens({ frontendApiUrl: FRONTEND, clientId: 'c', code: 'x', codeVerifier: 'v', redirectUri: 'r' })
    ).rejects.toBeInstanceOf(OAuthTokenExchangeError)
  })
})

describe('refreshAccessToken', () => {
  it('POSTs form-encoded refresh-token grant and maps the rotated tokens', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: header('aud_x'), refresh_token: 'rt2', expires_in: 900 }), {
          status: 200,
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const tokens = await refreshAccessToken({ frontendApiUrl: FRONTEND, clientId: 'client_1', refreshToken: 'rt1' })
    expect(tokens.refreshToken).toBe('rt2')
    expect(tokens.accessTokenExpiry).toBeGreaterThan(0)
    const call = fetchMock.mock.calls[0] as unknown as [string, { body: URLSearchParams }]
    expect(call[0]).toBe(`${FRONTEND}/oauth/token`)
    expect(call[1].body.get('grant_type')).toBe('refresh_token')
    expect(call[1].body.get('refresh_token')).toBe('rt1')
  })

  it('throws OAuthRefreshFailedError on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 }))
    )
    await expect(
      refreshAccessToken({ frontendApiUrl: FRONTEND, clientId: 'c', refreshToken: 'dead' })
    ).rejects.toBeInstanceOf(OAuthRefreshFailedError)
  })
})

describe('decodeIdTokenSid', () => {
  it('extracts sid from a valid JWT payload', () => {
    const payload = Buffer.from(JSON.stringify({ sid: 'sess_abc123', exp: 9999 })).toString('base64url')
    const token = `header.${payload}.sig`
    expect(decodeIdTokenSid(token)).toBe('sess_abc123')
  })

  it('returns undefined when sid is absent from the payload', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user_x', exp: 9999 })).toString('base64url')
    const token = `header.${payload}.sig`
    expect(decodeIdTokenSid(token)).toBeUndefined()
  })

  it('returns undefined when sid is not a string', () => {
    const payload = Buffer.from(JSON.stringify({ sid: 42, exp: 9999 })).toString('base64url')
    const token = `header.${payload}.sig`
    expect(decodeIdTokenSid(token)).toBeUndefined()
  })

  it('returns undefined for a malformed JWT (not enough parts)', () => {
    expect(decodeIdTokenSid('not.a.jwt')).toBeUndefined()
  })

  it('returns undefined for an empty string', () => {
    expect(decodeIdTokenSid('')).toBeUndefined()
  })

  it('returns undefined when the payload is invalid base64', () => {
    expect(decodeIdTokenSid('header.!!!invalid!!!.sig')).toBeUndefined()
  })
})

// helper: a JWT whose payload has an exp ~15m out
function header(aud: string): string {
  const payload = Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url')
  return `h.${payload}.s`
}
