import { ConvexError, v } from 'convex/values'

import { authenticatedMutation, getIdentity } from '../utils/auth'
import { isValidEmail, normalizeEmail } from '../utils/domainGate'

export const add = authenticatedMutation({
  args: { email: v.string() },
  returns: v.id('allowedEmails'),
  handler: async (ctx, { email }) => {
    const normalized = normalizeEmail(email)
    if (!isValidEmail(normalized)) {
      throw new ConvexError({
        code: 'EMAIL_INVALID',
        message: `'${email}' is not a valid email address.`,
      })
    }
    const existing = await ctx.db
      .query('allowedEmails')
      .withIndex('byEmail', (q) => q.eq('email', normalized))
      .unique()
    if (existing) return existing._id

    const identity = getIdentity(ctx)
    const userRow = await ctx.db
      .query('users')
      .withIndex('byExternalId', (q) => q.eq('externalId', identity.subject))
      .unique()

    return await ctx.db.insert('allowedEmails', {
      email: normalized,
      addedAtMs: Date.now(),
      addedByUserId: userRow?._id,
    })
  },
})

export const remove = authenticatedMutation({
  args: { id: v.id('allowedEmails') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get('allowedEmails', id)
    if (!row) return null

    // Mirror `allowedDomains.mutations.remove`'s self-removal guard. If
    // the row matches the caller's own email (case-insensitive), reject.
    // Otherwise an admin could delete the explicit-email row that
    // currently grants them access, locking themselves out the moment
    // their domain is also off the allowlist.
    const identity = getIdentity(ctx)
    const callerEmail = typeof identity.email === 'string' ? identity.email.toLowerCase() : ''
    if (callerEmail.length > 0 && row.email.toLowerCase() === callerEmail) {
      throw new ConvexError({
        code: 'CANNOT_REMOVE_OWN_EMAIL',
        message: 'You cannot remove the explicit-email entry that matches your own email.',
      })
    }

    await ctx.db.delete('allowedEmails', id)
    return null
  },
})
