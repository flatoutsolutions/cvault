import { ConvexError, v } from 'convex/values'

import { authenticatedMutation, getIdentity } from '../utils/auth'
import { isValidDomain, normalizeDomain } from '../utils/domainGate'

export const add = authenticatedMutation({
  args: { domain: v.string() },
  returns: v.id('allowedEmailDomains'),
  handler: async (ctx, { domain }) => {
    const normalized = normalizeDomain(domain)
    if (!isValidDomain(normalized)) {
      throw new ConvexError({
        code: 'INVALID_DOMAIN',
        message: `'${domain}' is not a valid domain.`,
      })
    }
    const existing = await ctx.db
      .query('allowedEmailDomains')
      .withIndex('byDomain', (q) => q.eq('domain', normalized))
      .unique()
    if (existing) return existing._id

    const identity = getIdentity(ctx)
    const userRow = await ctx.db
      .query('users')
      .withIndex('byExternalId', (q) => q.eq('externalId', identity.subject))
      .unique()

    return await ctx.db.insert('allowedEmailDomains', {
      domain: normalized,
      addedAtMs: Date.now(),
      addedByUserId: userRow?._id,
    })
  },
})

export const remove = authenticatedMutation({
  args: { id: v.id('allowedEmailDomains') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get('allowedEmailDomains', id)
    if (!row) return null

    const identity = getIdentity(ctx)
    const callerEmail = typeof identity.email === 'string' ? identity.email : ''
    const callerDomain = callerEmail.split('@')[1]?.toLowerCase()
    if (callerDomain && row.domain.toLowerCase() === callerDomain) {
      throw new ConvexError({
        code: 'CANNOT_REMOVE_OWN_DOMAIN',
        message: 'You cannot remove the domain that your own email belongs to.',
      })
    }

    await ctx.db.delete('allowedEmailDomains', id)
    return null
  },
})
