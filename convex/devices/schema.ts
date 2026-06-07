/**
 * Devices — server-side registry of CLI machines.
 *
 * One row per (user, machine). A "machine" is identified by a persistent
 * UUID the CLI generates and stores in ~/.vault/machine-id. The id is a
 * display/grouping label ONLY — never an authorization input. Revocation
 * acts on the `revokedSessions` denylist (by the captured `sid`, for instant
 * per-machine lockout) plus a best-effort Clerk BAPI session-revoke; a
 * user-level ban uses the `revokedUsers` denylist.
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
  /**
   * Reserved for a future Clerk OAuth grant id. VESTIGIAL today: the CLI never
   * populates it (the OAuth token response/PKCE flow here captures no grant id),
   * and revocation goes through `sid`/`revokedSessions`, not the grant. Kept so
   * a future grant-revoke path has somewhere to store it without a schema bump.
   */
  grantRef: v.optional(v.string()),
  /** Clerk session id captured at login (from the OIDC id-token `sid` claim).
   *  Written to the `revokedSessions` denylist on device revoke so the machine
   *  is locked out instantly without waiting for token expiry. */
  sid: v.optional(v.string()),
})
  .index('byUserAndMachine', ['userId', 'machineId'])
  .index('byMachine', ['machineId'])
