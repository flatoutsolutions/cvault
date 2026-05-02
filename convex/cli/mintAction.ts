'use node'

/**
 * `cli.mintAction.mintConvexJwt` — internal action invoked by the
 * `/api/cli/mint-token` HTTP route. Verifies a CLI-supplied Clerk session
 * JWT via `@clerk/backend`, then mints a convex-template JWT for the
 * underlying session via Clerk Backend API.
 *
 * Why this exists:
 *   The CLI obtains a Clerk session JWT via FAPI's ticket exchange
 *   (`/v1/client/sign_ins`), but cannot mint subsequent template JWTs via
 *   FAPI because `/v1/client/sessions/<sid>/tokens/<template>` authenticates
 *   the *client* (browser cookie context). From a headless caller without
 *   the `__client` cookie, FAPI rejects every Authorization Bearer with 401
 *   `signed_out`. BAPI does not have that constraint — it only requires the
 *   server-side `CLERK_SECRET_KEY`, which lives on the Convex deployment.
 *
 * Security model:
 *   - We `verifyToken` the supplied JWT against Clerk's JWKS first. This
 *     proves the caller actually possesses a current Clerk session token —
 *     they are not asking us to mint for an arbitrary `sid` they guessed.
 *   - The `sid` claim from the verified payload is what we pass to BAPI;
 *     `clerkSessionToken` is never trusted as input beyond its `sid`/`sub`
 *     claims.
 *   - Without verification, a user holding any Clerk JWT could pass a
 *     stolen `sid` and mint a convex JWT for someone else. The secret key
 *     would be a confused deputy.
 */
import { verifyToken } from '@clerk/backend'
import { ConvexError, v } from 'convex/values'

import { internalAction } from '../_generated/server'

import { createSessionTokenFromTemplate } from './clerk'

export const mintConvexJwt = internalAction({
  args: { clerkSessionToken: v.string() },
  returns: v.object({ jwt: v.string() }),
  handler: async (_ctx, { clerkSessionToken }): Promise<{ jwt: string }> => {
    const secretKey = process.env.CLERK_SECRET_KEY
    if (!secretKey) {
      throw new ConvexError({
        code: 'CONFIGURATION_ERROR',
        message: 'CLERK_SECRET_KEY is not set on the Convex deployment',
      })
    }

    let payload: { sid?: unknown; sub?: unknown }
    try {
      payload = (await verifyToken(clerkSessionToken, { secretKey })) as {
        sid?: unknown
        sub?: unknown
      }
    } catch (err) {
      throw new ConvexError({
        code: 'SESSION_TOKEN_INVALID',
        message: `Could not verify Clerk session token: ${
          err instanceof Error ? err.message : String(err)
        }`,
      })
    }

    if (typeof payload.sid !== 'string' || typeof payload.sub !== 'string') {
      throw new ConvexError({
        code: 'SESSION_TOKEN_INVALID',
        message: 'Clerk session token is missing `sid` or `sub` claims',
      })
    }

    const result = await createSessionTokenFromTemplate(payload.sid, 'convex')
    if (!result.ok) {
      throw new ConvexError({
        code: result.status === 404 ? 'JWT_TEMPLATE_NOT_FOUND' : 'CLERK_BACKEND_ERROR',
        message: `BAPI mint failed: ${result.status.toString()}: ${result.body.slice(0, 200)}`,
      })
    }

    return { jwt: result.jwt }
  },
})
