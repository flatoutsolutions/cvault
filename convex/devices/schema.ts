/**
 * Devices — server-side registry of CLI machines.
 *
 * One row per (user, machine). A "machine" is identified by a persistent
 * UUID the CLI generates and stores in ~/.vault/machine-id. The id is a
 * display/grouping label ONLY — never an authorization input. Revocation
 * acts on the Clerk OAuth grant (grantRef) + the revokedUsers denylist.
 */
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const devicesSchema = defineTable({
  userId: v.id('users'),
  machineId: v.string(),
  label: v.optional(v.string()),
  createdAt: v.number(),
  lastSeenAt: v.number(),
  revokedAt: v.optional(v.number()),
  /** Clerk OAuth grant id captured at login, used to revoke this machine. */
  grantRef: v.optional(v.string()),
})
  .index('byUserAndMachine', ['userId', 'machineId'])
  .index('byMachine', ['machineId'])
