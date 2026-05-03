'use node'

/**
 * Thin wrapper around the few Clerk Backend API endpoints the cvault
 * server side touches:
 *
 *  1. POST /v1/sign_in_tokens         - mint a sign-in token for `user_id`
 *  2. POST /v1/sessions/:id/revoke    - revoke a Clerk session
 *
 * Both are mockable via the `__setClerkFetch` test seam so unit tests can
 * inject a stub instead of hitting Clerk.
 *
 * Reference: docs/research/clerk-convex-tanstack-integration.md §4.
 */
import { ConvexError } from 'convex/values'

const CLERK_API_BASE = 'https://api.clerk.com'

let _fetch: typeof fetch | undefined

export function __setClerkFetch(stub: typeof fetch | undefined): void {
  _fetch = stub
}

function activeFetch(): typeof fetch {
  return _fetch ?? fetch
}

function loadSecretKey(): string {
  const key = process.env.CLERK_SECRET_KEY
  if (!key) {
    // Throw ConvexError so callers see the real reason in dashboard toasts;
    // a plain `Error` here surfaces on the client as the generic masked
    // "Server Error" string and silently rules out the most common deploy
    // misconfiguration when users debug.
    throw new ConvexError({
      code: 'CLERK_SECRET_KEY_MISSING',
      message: 'CLERK_SECRET_KEY env var is not set on the Convex deployment',
    })
  }
  return key
}

interface SignInTokenSuccess {
  ok: true
  signInTokenId: string
  signInToken: string
  expiresAt: number | null
}

interface SignInTokenError {
  ok: false
  status: number
  body: string
}

export type SignInTokenResult = SignInTokenSuccess | SignInTokenError

/**
 * Mint a single-use Clerk sign-in token for `userId`.
 *
 * The token can then be exchanged client-side via:
 *   POST <CLERK_FRONTEND_API>/v1/client/sign_ins
 *   { strategy: "ticket", ticket: <signInToken> }
 *
 * @param userId        Clerk user_id (e.g. "user_abcXYZ")
 * @param expiresInSec  Seconds until the token expires. Default 600 (10 min).
 */
export async function mintSignInToken(userId: string, expiresInSec = 600): Promise<SignInTokenResult> {
  const secret = loadSecretKey()
  const fn = activeFetch()

  const resp = await fn(`${CLERK_API_BASE}/v1/sign_in_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: expiresInSec }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    return { ok: false, status: resp.status, body }
  }

  const json = (await resp.json()) as {
    id?: unknown
    token?: unknown
    expires_at?: unknown
  }

  if (typeof json.id !== 'string' || typeof json.token !== 'string') {
    return { ok: false, status: resp.status, body: 'malformed Clerk response (missing id or token)' }
  }

  return {
    ok: true,
    signInTokenId: json.id,
    signInToken: json.token,
    expiresAt: typeof json.expires_at === 'number' ? json.expires_at : null,
  }
}

interface RevokeSessionSuccess {
  ok: true
}

interface RevokeSessionError {
  ok: false
  status: number
  body: string
}

export type RevokeSessionResult = RevokeSessionSuccess | RevokeSessionError

/**
 * Revoke a Clerk session by id. Used by `/dashboard/machines` "Revoke" button.
 */
export async function revokeClerkSession(clerkSessionId: string): Promise<RevokeSessionResult> {
  const secret = loadSecretKey()
  const fn = activeFetch()

  const resp = await fn(`${CLERK_API_BASE}/v1/sessions/${clerkSessionId}/revoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
    },
  })

  if (!resp.ok) {
    const body = await resp.text()
    return { ok: false, status: resp.status, body }
  }

  return { ok: true }
}

interface GetSessionSuccess {
  ok: true
  /** Clerk's `user_id` for the session — i.e., the user the session belongs to. */
  userId: string
}

interface GetSessionError {
  ok: false
  status: number
  body: string
}

export type GetSessionResult = GetSessionSuccess | GetSessionError

/**
 * Look up a Clerk session by id and return its owning `user_id`. Used by
 * `revokeSession` to verify the caller owns the session before revoking it
 * (defense against cross-tenant authz bypass: the deployment's
 * `CLERK_SECRET_KEY` would otherwise act as a confused deputy for any
 * signed-in user against the entire user base).
 */
export async function getClerkSession(clerkSessionId: string): Promise<GetSessionResult> {
  const secret = loadSecretKey()
  const fn = activeFetch()

  const resp = await fn(`${CLERK_API_BASE}/v1/sessions/${clerkSessionId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${secret}`,
    },
  })

  if (!resp.ok) {
    const body = await resp.text()
    return { ok: false, status: resp.status, body }
  }

  const json = (await resp.json()) as { user_id?: unknown }
  if (typeof json.user_id !== 'string') {
    return { ok: false, status: resp.status, body: 'malformed Clerk response (missing user_id)' }
  }

  return { ok: true, userId: json.user_id }
}

interface MintTemplateTokenSuccess {
  ok: true
  jwt: string
}

interface MintTemplateTokenError {
  ok: false
  status: number
  body: string
}

export type MintTemplateTokenResult = MintTemplateTokenSuccess | MintTemplateTokenError

/**
 * Mint a JWT for `sessionId` using the Clerk JWT template `templateName`
 * (e.g. `convex`). BAPI endpoint:
 *
 *   POST https://api.clerk.com/v1/sessions/{session_id}/tokens/{template_name}
 *
 * Used by the CLI's `/api/cli/mint-token` HTTP action: the CLI already has a
 * Clerk session (via FAPI ticket exchange) but cannot call FAPI's equivalent
 * endpoint because that one requires the browser `__client` cookie. Routing
 * through BAPI avoids the headless-FAPI auth gap.
 *
 * 404 typically means the JWT template does not exist on the Clerk instance.
 * 401 typically means the session has been revoked or expired.
 */
export async function createSessionTokenFromTemplate(
  sessionId: string,
  templateName: string,
  options: { expiresInSeconds?: number } = {}
): Promise<MintTemplateTokenResult> {
  const secret = loadSecretKey()
  const fn = activeFetch()

  // Clerk's default template lifetime is 60s — fine for browser apps that
  // re-mint on every WebSocket reconnect, but heavy for a one-shot CLI that
  // would otherwise hit `/api/cli/mint-token` on every Convex call. The
  // `expires_in_seconds` BAPI parameter overrides the template default
  // per-request (min 30, max 315360000). 1 hour is the chosen tradeoff:
  // few enough mints to be a non-issue, short enough that a leaked JWT
  // becomes useless within an oncall response window.
  const expiresInSeconds = options.expiresInSeconds ?? 3600

  const resp = await fn(`${CLERK_API_BASE}/v1/sessions/${sessionId}/tokens/${templateName}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expires_in_seconds: expiresInSeconds }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    return { ok: false, status: resp.status, body }
  }

  const json = (await resp.json()) as { jwt?: unknown }
  if (typeof json.jwt !== 'string') {
    return {
      ok: false,
      status: resp.status,
      body: 'malformed Clerk response (missing jwt)',
    }
  }
  return { ok: true, jwt: json.jwt }
}

interface DeleteUserSuccess {
  ok: true
}

interface DeleteUserError {
  ok: false
  status: number
  body: string
}

export type DeleteUserResult = DeleteUserSuccess | DeleteUserError

/**
 * Delete a Clerk user by id. Used by the Convex webhook to nuke users whose
 * primary email is not on the allowed domain.
 *
 * BAPI: DELETE https://api.clerk.com/v1/users/{user_id}
 *
 * Treats 404 as success — the user is gone, which is the intended end state.
 */
export async function deleteClerkUser(userId: string): Promise<DeleteUserResult> {
  const secret = loadSecretKey()
  const fn = activeFetch()

  const resp = await fn(`${CLERK_API_BASE}/v1/users/${userId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${secret}`,
    },
  })

  if (resp.status === 404) {
    // Already deleted — that's the goal.
    return { ok: true }
  }
  if (!resp.ok) {
    const body = await resp.text()
    return { ok: false, status: resp.status, body }
  }
  return { ok: true }
}
