'use node'

/**
 * CLI-supporting Convex actions.
 *
 * - `recordLogin({machineId, machineLabel?, grantRef?, sid?})` — called by the CLI
 *   immediately after login completes. Upserts the device row and records a
 *   `login` machineActivity row.
 *
 * - `revokeDevice({machineId})` — called from `/dashboard/machines` when the
 *   user clicks "Revoke". Looks up the device globally, denylists its sid in
 *   `revokedSessions` (instant lockout), best-effort revokes the Clerk session
 *   via BAPI (kills refresh token), marks the device revoked, and records a
 *   `remove` activity row.
 *
 * Spec: docs/superpowers/specs/2026-06-03-cli-oauth-pkce-design.md §4–5.
 */
import { ConvexError, v } from 'convex/values'

import { internal } from '../_generated/api'
import { authenticatedAction, getIdentity } from '../utils/auth'
import { revokeClerkSession } from './clerk'

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
    sid: v.optional(v.string()),
  },
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, { machineId, machineLabel, grantRef, sid }): Promise<{ recorded: boolean }> => {
    const identity = getIdentity(ctx)
    const userId = await ctx.runQuery(internal.users.actions.getIdByExternalId, { externalId: identity.subject })
    if (userId === null) {
      // User row missing (Clerk webhook hasn't fired yet). Caller can retry
      // after a short delay; no need to fail login itself.
      return { recorded: false }
    }
    const at = Date.now()
    await ctx.runMutation(internal.devices.mutations.upsert, {
      userId,
      machineId,
      label: machineLabel,
      at,
      grantRef,
      ...(sid !== undefined ? { sid } : {}),
    })
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
 * device row globally (any user can revoke any machine — shared vault),
 * denylists the session id in `revokedSessions` for instant lockout,
 * best-effort revokes the Clerk session via BAPI, marks the device revoked,
 * and records a `remove` activity row.
 */
export const revokeDevice = authenticatedAction({
  args: { machineId: v.string() },
  returns: v.object({ revoked: v.boolean() }),
  handler: async (ctx, { machineId }): Promise<{ revoked: boolean }> => {
    const identity = getIdentity(ctx)
    // Resolve device globally — the byMachine index makes machineId a
    // vault-wide unique key so any authenticated user can revoke any machine.
    const device = await ctx.runQuery(internal.devices.queries.getByMachine, { machineId })
    if (device === null) throw new ConvexError({ code: 'NOT_FOUND', message: 'Machine not found' })

    // Audit attribution: the `remove` row must name the ACTING caller (who
    // clicked Revoke), not `device.userId` (the machine owner). Under the
    // shared vault any user can revoke any machine, so attributing to the
    // owner falsely logged the action against the wrong person. Mirrors the
    // actor-vs-owner fix in upsertFromPlaintext / pullForSwitch / softRemove.
    const actorUserId = await ctx.runQuery(internal.users.actions.getIdByExternalId, {
      externalId: identity.subject,
    })
    if (actorUserId === null) {
      throw new ConvexError({
        code: 'USER_NOT_FOUND',
        message: 'No user row for caller. Sign in once to trigger the Clerk webhook, then retry.',
      })
    }

    const at = Date.now()

    // Instant Convex-level enforcement: denylist the Clerk session id.
    if (device.sid !== undefined) {
      await ctx.runMutation(internal.revokedSessions.mutations.revoke, {
        sid: device.sid,
        machineId,
        at,
      })

      // Defense-in-depth: kill the Clerk refresh token via BAPI so the machine
      // cannot renew the OAuth token. Best-effort — the denylist already
      // enforces lockout even if this call fails.
      try {
        const r = await revokeClerkSession(device.sid)
        if (!r.ok) {
          console.warn(`[revokeDevice] BAPI session revoke non-OK (${String(r.status)}): ${r.body}`)
        }
      } catch (e) {
        console.warn('[revokeDevice] BAPI session revoke threw (ignored):', e)
      }
    }

    // Mark the device row revoked.
    await ctx.runMutation(internal.devices.mutations.markRevoked, {
      userId: device.userId,
      machineId,
      at,
    })

    // Audit row. `userId` is the acting caller (see actorUserId above);
    // `machineId` is the TARGET machine being revoked (the relevant entity
    // for a remove event), not the caller's machine.
    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId: actorUserId,
      machineId,
      action: 'remove',
      at,
    })

    return { revoked: true }
  },
})
