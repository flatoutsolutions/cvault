import { describe, expect, it, vi } from 'vitest'
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken, OAuthTokenExchangeError } from '../../src/auth/oauthPkce'

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
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: header('aud_x'), refresh_token: 'rt', id_token: 'id', expires_in: 900 }), { status: 200 })
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
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code_verifier')).toBe('verifier')
  })

  it('throws OAuthTokenExchangeError on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 400 })))
    await expect(
      exchangeCodeForTokens({ frontendApiUrl: FRONTEND, clientId: 'c', code: 'x', codeVerifier: 'v', redirectUri: 'r' })
    ).rejects.toBeInstanceOf(OAuthTokenExchangeError)
  })
})

// helper: a JWT whose payload has an exp ~15m out
function header(aud: string): string {
  const payload = Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url')
  return `h.${payload}.s`
}
