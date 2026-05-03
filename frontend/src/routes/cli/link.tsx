/**
 * /cli/link — CLI auth-flow callback page.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §15.
 * Reference: docs/research/clerk-convex-tanstack-integration.md §4.
 *
 * Track B item 9 (perf): the page component lives in the sibling
 * `link.lazy.tsx`. This file holds the static route declaration plus
 * `validateSearch`, which TanStack Router requires to live in the
 * critical (non-lazy) chunk so navigation can validate before
 * deciding whether to lazy-load the component.
 */
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

/**
 * SECURITY: only accept localhost-shape redirects. Without this, a user
 * who follows a phishing link `?redirect=https://attacker.example.com&...`
 * causes the dashboard to POST the freshly minted Clerk sign-in token to
 * the attacker's URL, which the attacker can redeem via Clerk FAPI to
 * complete a sign-in as the victim. We use a strict allow-list (host +
 * scheme + IP-literal/named-host check) rather than a permissive regex.
 *
 * Allowed shapes:
 *   - http://127.0.0.1:<port>/<path>
 *   - http://[::1]:<port>/<path>
 *   - http://localhost:<port>/<path>
 *
 * Anything else — including `https://`, foreign hosts, subdomain attacks
 * like `localhost.attacker.example.com`, embedded credentials,
 * `javascript:` / `file:` / `data:` URLs — is rejected before the page
 * mounts (TanStack Router calls `validateSearch` synchronously).
 */
function isLocalhostHttpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  // Plain HTTP only; the localhost listener doesn't terminate TLS, and
  // allowing https:// here would let an attacker trick a careless user.
  if (url.protocol !== 'http:') return false
  // No userinfo (defense against `http://127.0.0.1:5/@attacker.com/cb`
  // parser-confusion patterns: most browsers + URL implementations strip
  // user/pass before host, but we belt-and-braces reject any presence).
  if (url.username !== '' || url.password !== '') return false
  // Strict host comparison. The WHATWG URL parser keeps the `[::1]`
  // brackets in `.hostname` for IPv6 hosts (verified empirically); we
  // accept both bracketed and unbracketed forms defensively.
  const hostname = url.hostname
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost'
}

export const searchSchema = z.object({
  // The localhost URL the CLI is listening on.
  redirect: z.string().url().refine(isLocalhostHttpUrl, {
    message: 'redirect must be an http://127.0.0.1:<port>/, http://[::1]:<port>/, or http://localhost:<port>/ URL',
  }),
  // CSRF-style nonce; the CLI generated this and we just echo it.
  state: z.string().min(8),
})

export const Route = createFileRoute('/cli/link')({
  validateSearch: searchSchema.parse,
})
