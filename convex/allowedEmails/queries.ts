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
