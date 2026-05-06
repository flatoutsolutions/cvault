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

/**
 * Gate predicate. Accepts an email when EITHER:
 *  - its domain matches a domain in `domains` (suffix match boundary on
 *    `@`), OR
 *  - the lowercased email matches an entry in `emails` (exact match).
 *
 * `emails` defaults to `[]` so existing callers (pre per-email allowlist)
 * stay backward-compatible — they pass two args and behavior is identical.
 *
 * Strict semantics: plus-tagged variants and whitespace-padded inputs are
 * NOT auto-matched. The caller is responsible for normalization.
 */
export function isAllowedEmail(
  email: string | null | undefined,
  domains: ReadonlyArray<string>,
  emails: ReadonlyArray<string> = []
): boolean {
  if (typeof email !== 'string') return false
  if (email.length === 0) return false
  if (/\s/.test(email)) return false
  if (!email.includes('@')) return false
  const lower = email.toLowerCase()
  for (const e of emails) {
    if (typeof e !== 'string') continue
    if (e.length === 0) continue
    if (lower === e.toLowerCase()) return true
  }
  for (const d of domains) {
    const dLower = d.toLowerCase()
    if (dLower.length === 0) continue
    if (lower.endsWith(`@${dLower}`)) return true
  }
  return false
}

/**
 * Extract the domain portion of an email address. Returns null if the
 * input has no `@`. Uses lastIndexOf so emails with multiple `@` (rare
 * but technically valid in quoted local-parts) resolve to the LAST
 * `@` — which matches the suffix-match boundary `isAllowedEmail` uses.
 *
 * Example: extractEmailDomain('multi@chunk@flatout.solutions')
 *          → 'flatout.solutions'   (matches isAllowedEmail's boundary)
 *
 * Example: extractEmailDomain('alice@flatout.solutions')
 *          → 'flatout.solutions'
 */
export function extractEmailDomain(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null
  const at = email.lastIndexOf('@')
  if (at < 0) return null
  return email.slice(at + 1).toLowerCase()
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

/**
 * Bootstrap allowlist of explicit emails. Empty by default — admins seed
 * via the dashboard `/dashboard/settings/emails` UI or via a one-off
 * `npx convex run` mutation. This exists so server helpers can return a
 * stable shape when the table is empty (mirrors BOOTSTRAP_ALLOWED_DOMAINS).
 *
 * Intentionally does NOT contain personal addresses — we keep the bootstrap
 * minimal to avoid leaking real emails in source.
 */
export const BOOTSTRAP_ALLOWED_EMAILS: ReadonlyArray<string> = []

/**
 * Lowercase + trim. Defensive — does NOT alter the local-part beyond
 * casing (no plus-tag stripping, no quoted-pair canonicalization). The
 * allowlist semantics are exact-match: `samuel.asseg+work@gmail.com` is
 * a different address from `samuel.asseg@gmail.com`.
 */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase()
}

/**
 * Conservative email validator. Caller should `normalizeEmail` first.
 *
 * Rules:
 *  - non-empty, no whitespace anywhere
 *  - contains exactly ONE '@'
 *  - non-empty local part, non-empty domain part
 *  - domain part passes `isValidDomain`
 *
 * NOTE: stricter than RFC 5321 — quoted local-parts and multi-`@`
 * addresses are rejected because the gate's matching boundary uses
 * lastIndexOf semantics for domain extraction. Quoted local-parts are
 * exotic; if a real user shows up needing one we revisit.
 */
export function isValidEmail(input: string): boolean {
  if (typeof input !== 'string') return false
  if (input.length === 0) return false
  if (/\s/.test(input)) return false
  const at = input.indexOf('@')
  if (at < 0) return false
  if (input.indexOf('@', at + 1) >= 0) return false
  const local = input.slice(0, at)
  const domain = input.slice(at + 1)
  if (local.length === 0) return false
  if (domain.length === 0) return false
  return isValidDomain(domain)
}
