import { v } from 'convex/values'

import { internalQuery, query } from '../_generated/server'
import { BOOTSTRAP_ALLOWED_EMAILS } from '../utils/domainGate'

/**
 * Public query — used by:
 *  - the `/dashboard/settings/emails` UI (logged-in admins managing the
 *    list)
 *  - the `DomainGuard` component (must be public so unauthenticated/
 *    pre-auth render passes can consult the list without a chicken-and-
 *    egg dependency on `authenticatedQuery`).
 *
 * Mirrors `allowedDomains.queries.list`. Sorted ascending by email so
 * the UI is deterministic.
 *
 * Privacy trade-off: the list contents are enumerable by anyone who can
 * call this Convex function (no auth gate). The blocked page in
 * `DomainGuard` already renders the same contents to any signed-in
 * non-allowed user, so this isn't a new exposure surface vs. the existing
 * `allowedDomains.queries.list`. If the email allowlist ever holds
 * higher-sensitivity entries than domain allowlist (it likely will,
 * since domains are typically organizational and emails are personal),
 * a future iteration should split the read path:
 *   - `loadInternal` (already exists) → DomainGuard
 *   - `list` → admin-gated query for the settings UI only
 * That refactor is out of scope here to keep parity with the domain
 * pattern, but it's the right next step.
 */
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id('allowedEmails'),
      email: v.string(),
      addedAtMs: v.number(),
    })
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query('allowedEmails').collect()
    return rows
      .map((r) => ({ _id: r._id, email: r.email, addedAtMs: r.addedAtMs }))
      .sort((a, b) => a.email.localeCompare(b.email))
  },
})

/**
 * Internal query for action-context callers (mintAction, webhook). Returns
 * a flat `string[]` already lowercased — callers feed it directly into
 * `isAllowedEmail`'s third arg. Bootstrap fallback applies when the table
 * is empty (matches the BOOTSTRAP_ALLOWED_DOMAINS pattern).
 */
export const loadInternal = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const rows = await ctx.db.query('allowedEmails').collect()
    if (rows.length === 0) return [...BOOTSTRAP_ALLOWED_EMAILS]
    return rows.map((r) => r.email.toLowerCase())
  },
})
