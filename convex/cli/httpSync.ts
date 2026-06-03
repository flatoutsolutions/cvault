/**
 * GET /api/cli/sync — bundle endpoint used by `cvault sync --all`
 * to bootstrap a fresh machine.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5 (HTTP) + §7.
 *
 * Auth: caller MUST present a Clerk-issued JWT in `Authorization: Bearer ...`
 * matching the `convex` JWT template (same one the dashboard's WebSocket
 * uses). Convex verifies the JWT against the JWKS configured in
 * `convex/auth.config.ts`.
 *
 * Rate limit: this endpoint is the most attacker-attractive surface —
 * one request returns plaintext for ALL of the caller's subs. We cap
 * per user at 10 requests / hour so a leaked Clerk JWT can't be used
 * to mass-extract.
 *
 * The route is V8-runtime; decryption happens in the delegated Node action.
 *
 * Caller-session attribution: this route writes a `machineActivity`
 * row tagged with the {@link UNKNOWN_SESSION_SENTINEL} (see
 * `utils/identity.ts`). Today no CLI caller exercises this endpoint —
 * `cvault sync --all` uses the `pullForSwitch` action over WebSocket,
 * which receives the explicit `clerkSessionId` arg from
 * `VaultClient.withMeta()`. The HTTP route is kept available for
 * documented future use (e.g. a one-shot migration tool) but is
 * inherently sentinel-tagged because:
 *  - BAPI-minted JWTs lack a `sid` claim (Clerk reservation), and
 *  - this route has no action arg surface to receive an explicit sid.
 * If a future CLI version starts using this endpoint and needs proper
 * machine attribution, switch the caller to the `pullForSwitch` action
 * path rather than re-introducing a header-reading branch here — the
 * action path already enforces explicit-arg precedence.
 */
import { internal } from '../_generated/api'
import { httpAction } from '../_generated/server'
import { UNKNOWN_SESSION_SENTINEL } from '../utils/identity'

// CVLT-3: httpSync has no machineId arg surface (HTTP endpoint). It uses
// the Clerk sid claim when available, or the unknown-session sentinel.
// Future: if this endpoint gains a proper CLI caller, switch to the
// pullForSwitch action path which does have an explicit machineId arg.

const SYNC_RATE_LIMIT_KEY = 'cliSync'
const SYNC_RATE_LIMIT_CAPACITY = 10
const SYNC_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour

export const cliSyncHandler = httpAction(async (ctx, request) => {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Resolve the user row up-front so the rate limiter and audit row both
  // have the userId. If the user doesn't exist (Clerk webhook hasn't
  // fired) we treat this as 401 to avoid leaking the anomaly.
  const userId = await ctx.runQuery(internal.users.actions.getIdByExternalId, {
    externalId: identity.subject,
  })
  if (userId === null) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Enforce the per-user rate limit BEFORE building the bundle (which
  // would do `decrypt` work for every sub).
  const limit = await ctx.runMutation(internal.rateLimit.mutations.consume, {
    userId,
    key: SYNC_RATE_LIMIT_KEY,
    capacity: SYNC_RATE_LIMIT_CAPACITY,
    windowMs: SYNC_RATE_LIMIT_WINDOW_MS,
  })
  if (!limit.allowed) {
    return new Response(
      JSON.stringify({
        error: 'rate-limited: too many sync requests',
        retryAfterMs: limit.retryAfterMs,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': Math.ceil(limit.retryAfterMs / 1000).toString(),
        },
      }
    )
  }

  // Audit row. We have a real `Request` here so we can pass `rawIp` for
  // hashing — the only public surface that does (the WebSocket-driven
  // mutations don't have access to the underlying TCP peer).
  //
  // Caller-session attribution: see the file-level docstring. This route
  // is inherently sentinel-tagged. We still prefer `identity.sid` when
  // present (a future browser-side caller would have it from FAPI) but
  // fall back to the sentinel rather than reading a CLI-provided header,
  // because the action-path is the canonical CLI surface for explicit
  // session-id passing.
  const sidClaim = (identity as { sid?: unknown }).sid
  // Use the Clerk session id as a fallback machineId for this HTTP endpoint
  // (no CLI-generated UUID is available here). Sentinel for unauthenticated
  // or pre-PKCE callers.
  const machineId = typeof sidClaim === 'string' && sidClaim.length > 0 ? sidClaim : UNKNOWN_SESSION_SENTINEL
  // Standard reverse-proxy header for the originating client IP. We
  // take only the first hop (the rest are intermediaries we don't trust).
  const xff = request.headers.get('x-forwarded-for')
  const rawIp = xff !== null ? xff.split(',')[0]?.trim() : undefined
  await ctx.runMutation(internal.machineActivity.mutations.record, {
    userId,
    machineId,
    action: 'pull',
    at: Date.now(),
    rawIp: rawIp !== undefined && rawIp.length > 0 ? rawIp : undefined,
  })

  const bundle = await ctx.runAction(internal.cli.syncAction.buildBundleForUser, {
    externalId: identity.subject,
  })

  return new Response(JSON.stringify(bundle), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
})
