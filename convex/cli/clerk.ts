/**
 * Thin wrapper around the Clerk Backend API endpoints the cvault server side
 * still touches after the OAuth PKCE migration (Task 19 hard cutover):
 *
 *  - DELETE /v1/users/:id  — used by the Clerk users webhook to BAPI-delete
 *    users whose primary email is not on the allowed domain/email list.
 *
 * The mint-token helpers (mintSignInToken, createSessionTokenFromTemplate,
 * revokeClerkSession, getClerkSession, getClerkBackendClient) were removed in
 * Task 19 along with the `/api/cli/mint-token` HTTP route.  If needed again,
 * retrieve from git history (commit before
 * "chore: remove ticket-flow auth (clerkFapi, mint-token, /cli/link)").
 *
 * `__setClerkFetch` is a test-seam kept so existing tests that drive
 * `deleteClerkUser` (webhook tests, scenario tests) do not need rewiring.
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
    throw new ConvexError({
      code: 'CLERK_SECRET_KEY_MISSING',
      message: 'CLERK_SECRET_KEY env var is not set on the Convex deployment',
    })
  }
  return key
}

interface ClerkApiSuccess {
  ok: true
}

interface ClerkApiError {
  ok: false
  status: number
  body: string
}

export type DeleteUserResult = ClerkApiSuccess | ClerkApiError
export type RevokeSessionResult = ClerkApiSuccess | ClerkApiError

/**
 * Revoke a Clerk session by session id. Called by `revokeDevice` as
 * defense-in-depth (kills the refresh token so the machine can't renew) after
 * the `revokedSessions` denylist has already been written (instant lockout).
 *
 * BAPI: POST https://api.clerk.com/v1/sessions/{session_id}/revoke
 *
 * Treats 404 as success — the session is gone, which is the intended end state.
 * Returns `{ ok: false, ... }` on other errors so callers can warn without
 * failing the overall revoke operation.
 */
export async function revokeClerkSession(sessionId: string): Promise<RevokeSessionResult> {
  const secret = loadSecretKey()
  const fn = activeFetch()

  const resp = await fn(`${CLERK_API_BASE}/v1/sessions/${sessionId}/revoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
    },
  })

  if (resp.status === 404) {
    // Already gone — that's the goal.
    return { ok: true }
  }
  if (!resp.ok) {
    const body = await resp.text()
    return { ok: false, status: resp.status, body }
  }
  return { ok: true }
}

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
