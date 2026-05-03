/**
 * Clerk Frontend API (FAPI) helpers used by the CLI auth flow.
 *
 * Spec: docs/research/clerk-convex-tanstack-integration.md §4-5.
 *
 * Two operations:
 *  - `exchangeTicketForSession`: trade the one-time sign-in token (received
 *    from the dashboard via the localhost callback) for a real Clerk session
 *    + immediately mint a Convex-template JWT.
 *  - `mintConvexJwt`: refresh the short-lived (60s) Convex JWT from the
 *    long-lived Clerk session token.
 *
 * Both endpoints expect a recognizable `User-Agent` so the Clerk dashboard's
 * session-list page shows "cvault CLI" instead of "Other".
 *
 * No `@clerk/backend` SDK call is needed for either op — the FAPI ticket
 * strategy is a frontend-only contract.
 */
import pkg from '../../package.json' with { type: 'json' }
import type { SessionState } from './session'

// Single source of truth for the CLI version — read from cli/package.json so
// every release bump (Formula + Cloudflare Pages reverse map) stays in sync
// with the User-Agent shipped on every Clerk FAPI + Convex mint request.
// Hardcoding the literal here was the original bug: `0.1.0` lingered after
// the package was bumped to `0.1.5`, leaking the wrong "device" label into
// Clerk's session-list UI.
export const CLI_VERSION = pkg.version

export class ClerkSessionExpiredError extends Error {
  override readonly name = 'ClerkSessionExpiredError'
  /** HTTP status from FAPI (401/403/404). */
  readonly status: number
  /** Truncated FAPI response body — Clerk returns JSON like
   *  `{"errors":[{"code":"resource_not_found"}]}` which distinguishes a
   *  missing JWT template from a revoked/expired session. */
  readonly body: string
  constructor(status: number, body: string) {
    super(
      `Clerk session expired or revoked. Re-run \`cvault login\`. ` +
        `(FAPI returned ${String(status)}: ${body.slice(0, 300)})`
    )
    this.status = status
    this.body = body
  }
}

/**
 * Build a recognizable User-Agent. Per
 * `clerk-convex-tanstack-integration.md` §6, the dashboard surfaces this
 * as the "device" label for sessions.
 */
export function cliUserAgent(): string {
  return `cvault-cli/${CLI_VERSION} (${process.platform}-${process.arch})`
}

/**
 * Decode the `exp` claim from a JWT without verifying the signature. We
 * trust this token because we just received it from FAPI over TLS; the
 * server-side will verify it again when we hit Convex.
 */
export function decodeJwtExp(jwt: string): number {
  const parts = jwt.split('.')
  if (parts.length < 2) {
    throw new Error('JWT does not have at least 2 parts')
  }
  const payloadB64Url = parts[1] ?? ''
  // Pad base64url to a multiple of 4 chars and convert URL-safe alphabet.
  const padded = payloadB64Url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(payloadB64Url.length + ((4 - (payloadB64Url.length % 4)) % 4), '=')
  let json: string
  try {
    json = Buffer.from(padded, 'base64').toString('utf8')
  } catch (err) {
    throw new Error(`Failed to base64-decode JWT payload: ${err instanceof Error ? err.message : String(err)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new Error(`JWT payload was not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || !('exp' in parsed)) {
    throw new Error('JWT payload is missing `exp`')
  }
  const exp = (parsed as { exp: unknown }).exp
  if (typeof exp !== 'number') {
    throw new Error('JWT `exp` is not a number')
  }
  return exp
}

export interface MintResult {
  convexJwt: string
  convexJwtExpiry: number
}

/**
 * Mint a fresh Convex-template JWT from the long-lived Clerk session token.
 *
 * Endpoint:
 *   POST {frontendApiUrl}/v1/client/sessions/{sessionId}/tokens/convex
 *   Authorization: Bearer {clerkSessionToken}
 *
 * Response:
 *   { jwt: "<60s-lived JWT>" }
 *
 * 401/403/404 → ClerkSessionExpiredError (the long-lived token is dead).
 * Other non-2xx → generic Error with the body for diagnosis.
 */
export async function mintConvexJwt(session: SessionState): Promise<MintResult> {
  // We mint via the Convex HTTP action `/api/cli/mint-token`, which uses the
  // Clerk Backend API (CLERK_SECRET_KEY) to call
  //   POST https://api.clerk.com/v1/sessions/<sid>/tokens/convex
  //
  // Why not FAPI directly: FAPI's `/v1/client/sessions/<sid>/tokens/<template>`
  // authenticates the *client* (browser cookie context), not the session JWT
  // we hold. From a headless CLI without the `__client` cookie, FAPI returns
  // 401 `signed_out` regardless of which session token we pass as Bearer. The
  // BAPI route uses the secret key on the server side and avoids the issue
  // entirely. The Convex action verifies the supplied session JWT via
  // `@clerk/backend` first so the secret key isn't a confused deputy.
  const url = `${session.convexUrl.replace(/\.convex\.cloud$/, '.convex.site')}/api/cli/mint-token`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': cliUserAgent(),
    },
    body: JSON.stringify({ clerkSessionToken: session.clerkSessionToken }),
  })
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    const body = await res.text().catch(() => '<no body>')
    throw new ClerkSessionExpiredError(res.status, body)
  }
  if (!res.ok) {
    throw new Error(`Convex mint endpoint failed: ${String(res.status)} ${await res.text()}`)
  }
  const body = (await res.json()) as { jwt: string }
  return { convexJwt: body.jwt, convexJwtExpiry: decodeJwtExp(body.jwt) }
}

export interface ExchangeOptions {
  /** Clerk sign-in token from the dashboard's localhost POST. */
  signInToken: string
  /** Clerk Frontend API URL (e.g. https://clear-redbird-6.clerk.accounts.dev). */
  frontendApiUrl: string
  /** Convex deployment URL (e.g. https://beloved-mouse-707.convex.cloud). */
  convexUrl: string
  /** Origin to send if Clerk's CORS check rejects bare requests. Optional. */
  dashboardOrigin?: string
}

interface ClerkSignInResponse {
  client?: {
    sessions?: Array<{ id: string; last_active_token?: { jwt: string } }>
    last_active_session_id?: string
  }
}

/**
 * Exchange the one-time sign-in token for a Clerk session, then mint the
 * first Convex JWT. Returns a complete `SessionState` ready to persist
 * via `writeSession`.
 */
export async function exchangeTicketForSession(opts: ExchangeOptions): Promise<SessionState> {
  // Step A — sign in via the ticket strategy. Body must be form-urlencoded.
  const signInRes = await fetch(`${opts.frontendApiUrl}/v1/client/sign_ins`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': cliUserAgent(),
      ...(opts.dashboardOrigin ? { Origin: opts.dashboardOrigin } : {}),
    },
    body: new URLSearchParams({
      strategy: 'ticket',
      ticket: opts.signInToken,
    }).toString(),
  })
  if (!signInRes.ok) {
    throw new Error(`Clerk FAPI sign_in failed: ${String(signInRes.status)} ${await signInRes.text()}`)
  }
  const signInBody = (await signInRes.json()) as ClerkSignInResponse
  const sessionId = signInBody.client?.last_active_session_id
  const session = signInBody.client?.sessions?.find((s) => s.id === sessionId)
  const clerkSessionToken = session?.last_active_token?.jwt
  if (!sessionId || !clerkSessionToken) {
    throw new Error('Clerk FAPI sign_in did not return a usable session token')
  }

  // Step B — mint the convex-template JWT immediately so the caller has
  // both pieces in one round trip.
  const stub: SessionState = {
    version: 1,
    clerkSessionId: sessionId,
    clerkSessionToken,
    convexJwt: '',
    convexJwtExpiry: 0,
    frontendApiUrl: opts.frontendApiUrl,
    convexUrl: opts.convexUrl,
    issuedAt: Math.floor(Date.now() / 1000),
  }
  const mint = await mintConvexJwt(stub)

  return {
    ...stub,
    convexJwt: mint.convexJwt,
    convexJwtExpiry: mint.convexJwtExpiry,
  }
}
