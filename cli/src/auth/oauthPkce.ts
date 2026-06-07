import pkg from '../../package.json' with { type: 'json' }

export const CLI_VERSION = pkg.version

export function cliUserAgent(): string {
  return `cvault-cli/${CLI_VERSION} (${process.platform}-${process.arch})`
}

export class OAuthAuthorizationDeniedError extends Error {
  override readonly name = 'OAuthAuthorizationDeniedError'
  constructor(reason: string) {
    super(`Authorization denied: ${reason}. Re-run \`cvault login\`.`)
  }
}
export class OAuthTokenExchangeError extends Error {
  override readonly name = 'OAuthTokenExchangeError'
  readonly status: number
  readonly body: string
  constructor(status: number, body: string) {
    super(`OAuth token exchange failed (${String(status)}): ${body.slice(0, 300)}`)
    this.status = status
    this.body = body
  }
}
export class OAuthRefreshFailedError extends Error {
  override readonly name = 'OAuthRefreshFailedError'
  readonly status: number
  constructor(status: number, body: string) {
    super(`Session expired — run \`cvault login\`. (refresh failed ${String(status)}: ${body.slice(0, 200)})`)
    this.status = status
  }
}

/** Decode the `sid` claim from a JWT id-token payload (no signature
 *  verification — the server re-verifies). Returns `undefined` on any parse
 *  failure so callers can treat a missing/malformed token gracefully. */
export function decodeIdTokenSid(idToken: string): string | undefined {
  try {
    const part = idToken.split('.')[1] ?? ''
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(json) as { sid?: unknown }
    if (typeof parsed.sid === 'string') return parsed.sid
    return undefined
  } catch {
    return undefined
  }
}

/** Decode a JWT `exp` claim (no signature verification; the server re-verifies). */
export function decodeJwtExp(jwt: string): number {
  const part = jwt.split('.')[1] ?? ''
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  const parsed = JSON.parse(json) as { exp?: unknown }
  if (typeof parsed.exp !== 'number') throw new Error('JWT payload missing numeric exp')
  return parsed.exp
}

export interface OAuthTokens {
  accessToken: string
  accessTokenExpiry: number
  refreshToken: string
  idToken?: string
}

export function buildAuthorizeUrl(opts: {
  frontendApiUrl: string
  clientId: string
  redirectUri: string
  scope: string
  codeChallenge: string
  state: string
}): string {
  const url = new URL(`${opts.frontendApiUrl}/oauth/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', opts.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('scope', opts.scope)
  url.searchParams.set('code_challenge', opts.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', opts.state)
  return url.toString()
}

interface TokenResponse {
  access_token: string
  /**
   * Optional: the OAuth spec (RFC 6749 §6) lets the refresh_token grant OMIT a
   * new refresh_token when the authorization server does NOT rotate it. In that
   * case the caller must keep using the prior one — see the `fallbackRefreshToken`
   * arg to {@link toTokens}.
   */
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

/**
 * @param fallbackRefreshToken used when the response omits `refresh_token`
 *   (non-rotating refresh grant). The authorization_code grant always returns
 *   one, so callers there pass nothing and a missing token is a hard error.
 */
function toTokens(body: TokenResponse, fallbackRefreshToken?: string): OAuthTokens {
  const refreshToken = body.refresh_token ?? fallbackRefreshToken
  if (refreshToken === undefined) {
    throw new Error('OAuth token response did not include a refresh_token')
  }
  return {
    accessToken: body.access_token,
    accessTokenExpiry: decodeJwtExp(body.access_token),
    refreshToken,
    ...(body.id_token !== undefined ? { idToken: body.id_token } : {}),
  }
}

export async function exchangeCodeForTokens(opts: {
  frontendApiUrl: string
  clientId: string
  code: string
  codeVerifier: string
  redirectUri: string
}): Promise<OAuthTokens> {
  const res = await fetch(`${opts.frontendApiUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': cliUserAgent() },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      code_verifier: opts.codeVerifier,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
    }),
  })
  if (!res.ok) throw new OAuthTokenExchangeError(res.status, await res.text().catch(() => ''))
  return toTokens((await res.json()) as TokenResponse)
}

export async function refreshAccessToken(opts: {
  frontendApiUrl: string
  clientId: string
  refreshToken: string
}): Promise<OAuthTokens> {
  const res = await fetch(`${opts.frontendApiUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': cliUserAgent() },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
    }),
  })
  if (!res.ok) throw new OAuthRefreshFailedError(res.status, await res.text().catch(() => ''))
  // Preserve the current refresh token if the server didn't rotate one.
  return toTokens((await res.json()) as TokenResponse, opts.refreshToken)
}
