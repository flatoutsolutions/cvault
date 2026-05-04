/**
 * POST /api/cli/mint-token — converts a CLI-supplied Clerk session JWT into
 * a convex-template JWT that the CLI can use as Bearer for Convex calls.
 *
 * Auth: NONE at the HTTP layer. The supplied `clerkSessionToken` is
 * verified inside the delegated `cli.mintAction.mintConvexJwt` action via
 * `@clerk/backend`. That verification is what authorizes the mint —
 * possessing a live Clerk session JWT proves the caller is the owning user.
 *
 * Lifetime: this endpoint is the CLI's *refresh* path. Every ~60 seconds the
 * cached convex JWT expires; the CLI hits this endpoint to mint a new one
 * from the long-lived session JWT. It is also called once at the end of
 * `cvault login` to obtain the first convex JWT.
 *
 * Errors:
 *   - 400 — body missing / malformed
 *   - 401 — `SESSION_TOKEN_INVALID` (signature, expiry, revocation)
 *   - 403 — `EMAIL_DOMAIN_NOT_ALLOWED` (caller's email is not on the allowlist)
 *   - 404 — `JWT_TEMPLATE_NOT_FOUND` (no `convex` template in Clerk)
 *   - 500 — `CONFIGURATION_ERROR` / `CLERK_BACKEND_ERROR`
 */
import { ConvexError } from 'convex/values'

import { internal } from '../_generated/api'
import { httpAction } from '../_generated/server'

interface MintRequestBody {
  clerkSessionToken?: unknown
}

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export const cliMintHandler = httpAction(async (ctx, request) => {
  let parsed: MintRequestBody
  try {
    parsed = (await request.json()) as MintRequestBody
  } catch {
    return jsonResponse(400, { error: 'malformed JSON body' })
  }
  if (typeof parsed.clerkSessionToken !== 'string' || parsed.clerkSessionToken.length === 0) {
    return jsonResponse(400, { error: 'clerkSessionToken is required' })
  }

  try {
    const result = await ctx.runAction(internal.cli.mintAction.mintConvexJwt, {
      clerkSessionToken: parsed.clerkSessionToken,
    })
    return jsonResponse(200, { jwt: result.jwt })
  } catch (err) {
    if (err instanceof ConvexError) {
      const data = err.data as { code?: unknown; message?: unknown }
      const code = typeof data.code === 'string' ? data.code : 'UNKNOWN'
      const message = typeof data.message === 'string' ? data.message : err.message
      const status =
        code === 'SESSION_TOKEN_INVALID'
          ? 401
          : code === 'EMAIL_DOMAIN_NOT_ALLOWED'
            ? 403
            : code === 'JWT_TEMPLATE_NOT_FOUND'
              ? 404
              : code === 'CONFIGURATION_ERROR'
                ? 500
                : 500
      return jsonResponse(status, { error: code, message })
    }
    return jsonResponse(500, {
      error: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})
