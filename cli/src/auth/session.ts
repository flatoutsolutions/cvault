/**
 * `~/.vault/session.json` — durable Clerk session state for the CLI.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7 +
 * docs/research/clerk-convex-tanstack-integration.md §4-5.
 *
 * The file holds:
 *  - the long-lived Clerk session id + token (refreshes are minted from these)
 *  - the most recent short-lived Convex-template JWT + its exp claim
 *  - the deployment URLs the CLI is bound to
 *  - some metadata so the dashboard can label this machine
 *
 * Permissions: file mode 0600, dir mode 0700. Loose perms are rejected on
 * read to defend against shared-system snooping.
 */
import { readSecret, vaultFile, writeSecret } from '../paths'

export interface SessionState {
  /** File-format version. Bumps require a migration. */
  version: 1
  /** Clerk user_id (e.g. user_2NxYZ…) — populated post-login. Optional. */
  clerkUserId?: string
  /** Clerk session id (sess_…) — long-lived. */
  clerkSessionId: string
  /** Long-lived Clerk session JWT. Used to mint short-lived convex JWTs. */
  clerkSessionToken: string
  /** Most recent short-lived convex-template JWT. */
  convexJwt: string
  /** `exp` claim from convexJwt, in unix seconds. */
  convexJwtExpiry: number
  /** Clerk Frontend API base URL (used for token mints + ticket exchange). */
  frontendApiUrl: string
  /** Convex deployment URL (`https://<deployment>.convex.cloud`). */
  convexUrl: string
  /** Unix seconds when this session was first issued. */
  issuedAt: number
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
 * `NotLoggedInError` if the file is missing.
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
    throw new Error(
      `Failed to parse session.json: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return parsed as SessionState
}

/**
 * Persist the session to `~/.vault/session.json` with mode 0600 atomically.
 */
export async function writeSession(state: SessionState): Promise<void> {
  await writeSecret(sessionFilePath(), JSON.stringify(state, null, 2))
}
