import { v } from 'convex/values'

import { internalQuery } from '../_generated/server'

/**
 * Combined denylist check — one round-trip for both the user ban and session
 * (device) ban tables. Used by `assertDenylist` in `convex/utils/auth.ts` so
 * an authenticated action pays only ONE `runQuery` instead of two.
 *
 * `sid` is optional: dashboard / cron tokens carry no sid claim, in which case
 * `sessionRevoked` is always false.
 */
export const check = internalQuery({
  args: {
    externalId: v.string(),
    sid: v.optional(v.string()),
  },
  returns: v.object({ userRevoked: v.boolean(), sessionRevoked: v.boolean() }),
  handler: async (ctx, { externalId, sid }) => {
    const userRow = await ctx.db
      .query('revokedUsers')
      .withIndex('byExternalId', (q) => q.eq('externalId', externalId))
      .unique()

    const sessionRow =
      sid !== undefined && sid.length > 0
        ? await ctx.db
            .query('revokedSessions')
            .withIndex('bySid', (q) => q.eq('sid', sid))
            .unique()
        : null

    return {
      userRevoked: userRow !== null,
      sessionRevoked: sessionRow !== null,
    }
  },
})
