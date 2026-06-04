import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/** Denylist of revoked Clerk session ids (token `sid`). Checked in the auth
 *  wrapper for instant per-machine lockout. */
export const revokedSessionsSchema = defineTable({
  sid: v.string(),
  machineId: v.optional(v.string()),
  at: v.number(),
}).index('bySid', ['sid'])
