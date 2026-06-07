/**
 * `~/.vault/session.json` — durable OAuth session state for the CLI.
 *
 * Spec: docs/superpowers/plans/2026-06-03-cli-oauth-pkce.md §Task 12.
 *
 * The file holds:
 *  - OAuth access token + its expiry (JWT exp, unix seconds)
 *  - Refresh token for silent renewal
 *  - Optional OIDC id_token
 *  - Clerk Frontend API URL + OAuth Client ID (needed for refresh)
 *  - Convex deployment URL
 *  - Optional human-readable machine label
 *
 * Permissions: file mode 0600, dir mode 0700. Loose perms are rejected on
 * read to defend against shared-system snooping.
 *
 * Version guard: `version !== 2` (i.e. the old Clerk-ticket v1 sessions)
 * triggers a NotLoggedInError so the user re-authenticates via OAuth PKCE.
 */
import { readSecret, vaultFile, writeSecret } from '../paths'

export interface SessionState {
  /** File-format version. v2 = OAuth PKCE tokens. */
  version: 2
  /** Clerk OAuth access token (short-lived JWT). */
  accessToken: string
  /** `exp` claim from accessToken, in unix seconds. */
  accessTokenExpiry: number
  /** Clerk OAuth refresh token (long-lived). */
  refreshToken: string
  /** Optional OIDC id_token returned alongside the access token. */
  idToken?: string
  /** Clerk Frontend API base URL — used for token refresh calls. */
  frontendApiUrl: string
  /** Clerk OAuth Client ID — needed for public-client token exchange/refresh. */
  clientId: string
  /** Convex deployment URL (`https://<deployment>.convex.cloud`). */
  convexUrl: string
  /** Optional human label (defaults to hostname) for dashboard display. */
  machineLabel?: string
}

export class NotLoggedInError extends Error {
  override readonly name = 'NotLoggedInError'
  constructor() {
    super('Not logged in. Run `cvault login`.')
  }
}

/**
 * Path of `~/.vault/session.json`. Re-evaluates `HOME` per-call so tests
 * can stub it via `vi.stubEnv('HOME', tmp)`.
 */
export function sessionFilePath(): string {
  return vaultFile('session.json')
}

/**
 * Read the persisted session. Returns the parsed state or throws
 * `NotLoggedInError` if the file is missing or the stored session is not
 * the v2 OAuth shape (e.g. a leftover v1 Clerk-ticket session).
 *
 * Throws on loose perms (defense-in-depth — see `paths.readSecret`).
 */
export async function readSession(): Promise<SessionState> {
  const text = await readSecret(sessionFilePath())
  if (text === null) {
    throw new NotLoggedInError()
  }
  // Parse defensively — corruption should surface as a clear error rather
  // than a TypeError from a downstream property access.
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`Failed to parse session.json: ${err instanceof Error ? err.message : String(err)}`)
  }
  const state = parsed as Partial<SessionState>
  // v1 (Clerk ticket era) and any other non-v2 blobs are rejected; the user
  // must re-authenticate so a fresh OAuth session is created.
  if (state.version !== 2) throw new NotLoggedInError()
  return parsed as SessionState
}

/**
 * Persist the session to `~/.vault/session.json` with mode 0600 atomically.
 */
export async function writeSession(state: SessionState): Promise<void> {
  await writeSecret(sessionFilePath(), JSON.stringify(state, null, 2))
}
