import { v } from 'convex/values'

import { internalQuery, query } from '../_generated/server'
import { BOOTSTRAP_ALLOWED_DOMAINS } from '../utils/domainGate'

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id('allowedEmailDomains'),
      domain: v.string(),
      addedAtMs: v.number(),
    })
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query('allowedEmailDomains').collect()
    return rows
      .map((r) => ({ _id: r._id, domain: r.domain, addedAtMs: r.addedAtMs }))
      .sort((a, b) => a.domain.localeCompare(b.domain))
  },
})

export const loadInternal = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const rows = await ctx.db.query('allowedEmailDomains').collect()
    if (rows.length === 0) return [...BOOTSTRAP_ALLOWED_DOMAINS]
    return rows.map((r) => r.domain.toLowerCase())
  },
})
