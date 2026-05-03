/**
 * Domain-gate: single source of truth for the email-domain allowlist.
 *
 * Imports nothing — keep it framework-free so frontend (TanStack Start) and
 * CLI (Bun) can import it without dragging Convex runtime types.
 *
 * Rule: the user's primary email must end with `@flatout.solutions`,
 * case-insensitively. No subdomains. No suffix-attacks.
 *
 * Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §3.2
 */

export const ALLOWED_EMAIL_DOMAIN = 'flatout.solutions'

export const DOMAIN_REJECTION_ERROR_CODE = 'EMAIL_DOMAIN_NOT_ALLOWED'

export const DOMAIN_REJECTION_MESSAGE = 'Only @flatout.solutions accounts may use cvault.'

const ALLOWED_SUFFIX = `@${ALLOWED_EMAIL_DOMAIN}`.toLowerCase()

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (typeof email !== 'string') return false
  if (email.length === 0) return false
  // Reject any whitespace anywhere in the email — Clerk should never send it,
  // and we don't want to accidentally accept '  alice@flatout.solutions  '.
  if (/\s/.test(email)) return false
  return email.toLowerCase().endsWith(ALLOWED_SUFFIX)
}
