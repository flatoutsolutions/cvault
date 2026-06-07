import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/** Hard-ban list keyed on the Clerk user id (token `sub`). Checked in the
 *  authenticatedQuery/Mutation/Action wrapper for instant user-level lockout. */
export const revokedUsersSchema = defineTable({
  externalId: v.string(),
  at: v.number(),
}).index('byExternalId', ['externalId'])
