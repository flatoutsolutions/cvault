/**
 * Caller-session resolution.
 *
 * Background: `identity.sid` is only auto-populated by Clerk for
 * FAPI-minted JWTs (i.e. dashboard browser sessions). BAPI-minted JWTs —
 * the path the cvault CLI uses via `cli/mintAction.ts` — never carry a
 * `sid` claim, even when the template includes a `{{session.id}}`
 * shortcode. Clerk reserves `sid` and refuses to interpolate
 * `{{session.id}}` outside the FAPI context. This is documented in
 * `docs/research/clerk-convex-tanstack-integration.md` (added with the
 * fix that introduced this helper).
 *
 * To keep the dashboard's per-machine activity attribution correct, every
 * audit-writing action that the CLI calls accepts an explicit
 * `clerkSessionId` arg. Callers (the CLI's `VaultClient`) inject it from
 * the locally-persisted `session.clerkSessionId`. Server-side we prefer
 * `identity.sid` when present (real FAPI origin) and fall back to the
 * arg otherwise.
 *
 * We deliberately do NOT verify the arg via Clerk Backend API on every
 * call: the audit row's `userId` already comes from the verified
 * `identity.subject`, so a malicious caller can at worst mislabel rows
 * within their own tenant. The cross-tenant authz boundary stays intact.
 */
import type { UserIdentity } from 'convex/server'

/**
 * Sentinel value written to `machineActivity.clerkSessionId` when no
 * real Clerk session is available (cron, server-context, or callers
 * that pre-date the explicit-arg convention).
 *
 * Use the constant rather than a literal so refactors (renames, casing
 * changes) only touch one place; use {@link isUnknownSession} for any
 * comparison so case/whitespace variants of the literal are normalized.
 */
export const UNKNOWN_SESSION_SENTINEL = 'unknown-session'

/**
 * Whether a string represents the "no real session" sentinel. Treats
 * non-string inputs as unknown (the same fall-through `resolveCallerSession`
 * uses) and trims + lowercases the input so accidental case/whitespace
 * drift in older audit rows or mistyped CLI args doesn't bypass the
 * sentinel checks downstream.
 */
export function isUnknownSession(s: string | undefined | null): boolean {
  if (typeof s !== 'string') return true
  return s.trim().toLowerCase() === UNKNOWN_SESSION_SENTINEL
}

/**
 * Resolve the canonical Clerk session id for an audit row. Order:
 *
 *   1. `identity.sid` (FAPI-origin tokens — dashboard).
 *   2. `argSid` (CLI-origin: passed explicitly by the client).
 *   3. {@link UNKNOWN_SESSION_SENTINEL} (cron, server-context, or callers
 *      that pre-date the explicit-arg convention). Surfaced in the
 *      Machines view with `revocable: false` so the row is visible but
 *      the Revoke button is disabled with a tooltip. See
 *      `convex/machineActivity/queries.ts:distinctSessionsForUser`.
 */
export function resolveCallerSession(identity: UserIdentity, argSid?: string): string {
  const idSid = (identity as { sid?: unknown }).sid
  if (typeof idSid === 'string' && idSid.length > 0) return idSid
  if (typeof argSid === 'string' && argSid.length > 0) return argSid
  return UNKNOWN_SESSION_SENTINEL
}
