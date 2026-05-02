'use node'

/**
 * CLI-supporting Convex actions.
 *
 * - `startLink({state})` — called from the dashboard when the CLI sent the
 *   user to `/cli/link?state=<nonce>`. Confirms the dashboard caller is a
 *   real Clerk user, then mints a single-use sign-in token via Clerk
 *   Backend API and returns it. The dashboard then POSTs the token to
 *   the localhost listener the CLI started.
 *
 * - `revokeSession({clerkSessionId})` — called from `/dashboard/machines`
 *   when the user clicks "Revoke". Must ensure the caller actually owns
 *   the session being revoked (we know this because Clerk session ids
 *   already encode the user; we just need to look it up).
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7 + §8.
 * Reference: docs/research/clerk-convex-tanstack-integration.md §4.
 */
import { ConvexError, v } from 'convex/values'

import { internal } from '../_generated/api'
import { authenticatedAction, getIdentity } from '../utils/auth'
import { getClerkSession, mintSignInToken, revokeClerkSession } from './clerk'

export const startLink = authenticatedAction({
  args: { state: v.string() },
  returns: v.object({ signInToken: v.string(), signInTokenId: v.string() }),
  handler: async (ctx, args): Promise<{ signInToken: string; signInTokenId: string }> => {
    const identity = getIdentity(ctx)
    const userId = identity.subject

    const result = await mintSignInToken(userId, 600)
    if (!result.ok) {
      throw new ConvexError({
        code: 'CLERK_BACKEND_ERROR',
        message: `Clerk sign-in token request failed: ${result.status.toString()}: ${result.body.slice(0, 200)}`,
      })
    }
    // The CLI never sees `state` directly here — the dashboard echoes it
    // back over the localhost callback so the CLI can correlate. We accept
    // it on the args so the dashboard knows the action signature it must
    // call (no semantic use server-side).
    void args.state
    return { signInToken: result.signInToken, signInTokenId: result.signInTokenId }
  },
})

export const revokeSession = authenticatedAction({
  args: { clerkSessionId: v.string() },
  returns: v.object({ revoked: v.boolean() }),
  handler: async (ctx, { clerkSessionId }): Promise<{ revoked: boolean }> => {
    const identity = getIdentity(ctx)

    // SECURITY: verify the caller actually owns the target session BEFORE
    // sending the revoke. Without this check, the deployment's
    // CLERK_SECRET_KEY acts as a confused deputy: any signed-in user could
    // call this action with someone else's clerkSessionId and revoke it.
    // Clerk session ids are not designed as unguessable secrets — they
    // appear in JWT `sid` claims, dashboards, and some logs.
    const lookup = await getClerkSession(clerkSessionId)
    if (!lookup.ok) {
      // Conflate "session does not exist" with "session not owned" to
      // avoid leaking session-existence info to a probing attacker.
      throw new ConvexError({
        code: 'NOT_FOUND',
        message: 'Session not found or not owned by current user',
      })
    }
    if (lookup.userId !== identity.subject) {
      throw new ConvexError({
        code: 'NOT_FOUND',
        message: 'Session not found or not owned by current user',
      })
    }

    const result = await revokeClerkSession(clerkSessionId)
    if (!result.ok) {
      throw new ConvexError({
        code: 'CLERK_BACKEND_ERROR',
        message: `Clerk session revoke failed: ${result.status.toString()}: ${result.body.slice(0, 200)}`,
      })
    }

    // Audit: record the revoke in machineActivity. Per spec §4 + §12 every
    // authenticated state-changing action should leave an audit row.
    const sidClaim = (identity as { sid?: unknown }).sid
    const callerSession = typeof sidClaim === 'string' ? sidClaim : 'unknown-session'
    // Resolve the user row so we can scope the activity correctly. If the
    // user row is missing (extremely rare; would mean the Clerk webhook
    // didn't fire) we still return success — the revoke already landed.
    const userId = await ctx.runQuery(internal.users.actions.getIdByExternalId, {
      externalId: identity.subject,
    })
    if (userId !== null) {
      await ctx.runMutation(internal.machineActivity.mutations.record, {
        userId,
        clerkSessionId: callerSession,
        action: 'remove',
        at: Date.now(),
      })
    }

    return { revoked: true }
  },
})

/**
 * `recordLogin({})` — called by the CLI immediately after `cvault login`
 * persists `~/.vault/session.json`. Inserts a `machineActivity` row with
 * `action='login'` so the dashboard `/machines` view (and audit feed)
 * surfaces every CLI pairing event.
 */
export const recordLogin = authenticatedAction({
  args: {},
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx): Promise<{ recorded: boolean }> => {
    const identity = getIdentity(ctx)
    const sidClaim = (identity as { sid?: unknown }).sid
    const callerSession = typeof sidClaim === 'string' ? sidClaim : 'unknown-session'

    const userId = await ctx.runQuery(internal.users.actions.getIdByExternalId, {
      externalId: identity.subject,
    })
    if (userId === null) {
      // User row missing (Clerk webhook hasn't fired yet). Caller can retry
      // after a short delay; no need to fail login itself.
      return { recorded: false }
    }

    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId,
      clerkSessionId: callerSession,
      action: 'login',
      at: Date.now(),
    })
    return { recorded: true }
  },
})
