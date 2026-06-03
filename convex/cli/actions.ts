'use node'

/**
 * CLI-supporting Convex actions.
 *
 * - `recordLogin({machineId, machineLabel?, grantRef?})` — called by the CLI
 *   immediately after login completes. Upserts the device row and records a
 *   `login` machineActivity row.
 *
 * - `revokeDevice({machineId})` — called from `/dashboard/machines` when the
 *   user clicks "Revoke". Looks up the device, revokes the Clerk OAuth grant
 *   (once Phase 0 wires the BAPI call), marks the device revoked, and records
 *   a `remove` activity row.
 *
 * Spec: docs/superpowers/specs/2026-06-03-cli-oauth-pkce-design.md §4–5.
 */
import { ConvexError, v } from 'convex/values'

import { internal } from '../_generated/api'
import { authenticatedAction, getIdentity } from '../utils/auth'
import { revokeOAuthGrant } from './oauthRevoke'

/**
 * `recordLogin` — called by the CLI immediately after a successful OAuth
 * login. Upserts the device row in the `devices` registry and records a
 * `login` row in `machineActivity` so the dashboard surfaces every CLI
 * pairing event.
 */
export const recordLogin = authenticatedAction({
  args: {
    machineId: v.string(),
    machineLabel: v.optional(v.string()),
    grantRef: v.optional(v.string()),
  },
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, { machineId, machineLabel, grantRef }): Promise<{ recorded: boolean }> => {
    const identity = getIdentity(ctx)
    const userId = await ctx.runQuery(internal.users.actions.getIdByExternalId, { externalId: identity.subject })
    if (userId === null) {
      // User row missing (Clerk webhook hasn't fired yet). Caller can retry
      // after a short delay; no need to fail login itself.
      return { recorded: false }
    }
    const at = Date.now()
    await ctx.runMutation(internal.devices.mutations.upsert, { userId, machineId, label: machineLabel, at, grantRef })
    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId,
      machineId,
      action: 'login',
      at,
      machineLabel,
    })
    return { recorded: true }
  },
})

/**
 * `revokeDevice` — called from the dashboard Machines view. Resolves the
 * device row, revokes the Clerk OAuth grant (Phase-0-deferred — see
 * `oauthRevoke.ts`), marks the device revoked, and records a `remove`
 * activity row.
 */
export const revokeDevice = authenticatedAction({
  args: { machineId: v.string() },
  returns: v.object({ revoked: v.boolean() }),
  handler: async (ctx, { machineId }): Promise<{ revoked: boolean }> => {
    const identity = getIdentity(ctx)
    const userId = await ctx.runQuery(internal.users.actions.getIdByExternalId, { externalId: identity.subject })
    if (userId === null) throw new ConvexError({ code: 'NOT_FOUND', message: 'User not found' })

    const device = await ctx.runQuery(internal.devices.queries.getForUser, { userId, machineId })
    if (device === null) throw new ConvexError({ code: 'NOT_FOUND', message: 'Machine not found' })

    // Revoke the Clerk OAuth grant so this machine can't renew. Exact endpoint
    // confirmed in Phase 0 Task 0 Step 5; implemented in convex/cli/oauthRevoke.ts.
    if (device.grantRef !== undefined) {
      await revokeOAuthGrant(device.grantRef)
    }

    const at = Date.now()
    await ctx.runMutation(internal.devices.mutations.markRevoked, { userId, machineId, at })
    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId,
      machineId,
      action: 'remove',
      at,
    })

    return { revoked: true }
  },
})
