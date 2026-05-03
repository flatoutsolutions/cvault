/**
 * Domain-gate: pure helper module for the email-domain allowlist.
 *
 * No imports — keep framework-free so frontend (TanStack Start) and CLI
 * (Bun) can import without dragging Convex runtime types.
 *
 * Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §3.2
 */

export const BOOTSTRAP_ALLOWED_DOMAINS: ReadonlyArray<string> = ['flatout.solutions']

export const DOMAIN_REJECTION_ERROR_CODE = 'EMAIL_DOMAIN_NOT_ALLOWED'

export const DOMAIN_REJECTION_MESSAGE = 'Your email domain is not allowed to use cvault.'

export function isAllowedEmail(email: string | null | undefined, domains: ReadonlyArray<string>): boolean {
  if (typeof email !== 'string') return false
  if (email.length === 0) return false
  if (/\s/.test(email)) return false
  if (!email.includes('@')) return false
  const lower = email.toLowerCase()
  for (const d of domains) {
    const dLower = d.toLowerCase()
    if (dLower.length === 0) continue
    if (lower.endsWith(`@${dLower}`)) return true
  }
  return false
}

/** Lowercase, trim, strip a single leading `@`. */
export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^@/, '')
}

/**
 * Conservative domain validator. Caller should `normalizeDomain` first.
 */
export function isValidDomain(input: string): boolean {
  if (typeof input !== 'string') return false
  if (input.length === 0 || input.length > 253) return false
  if (input.startsWith('@')) return false
  if (input.includes(' ')) return false
  const labels = input.split('.')
  if (labels.length < 2) return false
  return labels.every((lbl) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(lbl))
}
