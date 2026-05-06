/**
 * Tier note: this is a deterministic, fully mocked regression test stored
 * in the `scenarios/` tier per project convention — scenario tests
 * exercise end-to-end shapes the user experiences (here: the full
 * `mintConvexJwt` error-classification path from Convex 404 → CLI error
 * class → user-facing message). Despite the directory name there is no
 * live network — `globalThis.fetch` is stubbed for each case.
 *
 * Scenario — `mintConvexJwt` distinguishes a wrong-deployment 404 from
 * a real Clerk-session-expired 404.
 *
 * Background:
 *   Before this fix, `mintConvexJwt` mapped any 404 from
 *   `<convex>/api/cli/mint-token` to `ClerkSessionExpiredError`, which
 *   prints "Clerk session expired or revoked. Re-run `cvault login`."
 *   That's misleading when the actual cause is the CLI pointing at a
 *   foreign Convex deployment that simply has no `/api/cli/*` route at
 *   all (response body: "No matching routes found").
 *
 *   The fix introduces `ConvexEndpointNotFoundError`, thrown only on
 *   404 + the unrouted-deployment marker body. Other 404s (e.g. JWT
 *   template missing) keep the legacy `ClerkSessionExpiredError`.
 *
 * What this scenario asserts (the END-TO-END path the user hits when
 * they accidentally launch the CLI from a project with a foreign
 * `.env.local`):
 *   1. `mintConvexJwt` against a stub fetch that returns 404 + "No
 *      matching routes found" throws `ConvexEndpointNotFoundError`.
 *   2. The error is NOT a `ClerkSessionExpiredError` (so login.ts can
 *      dispatch on the new class without ambiguity).
 *   3. The thrown error's `.message` includes the URL (so the user can
 *      see at a glance which deployment was hit) AND a pointer at
 *      `.env.local` (the most likely cause).
 *
 * The Convex `/api/cli/mint-token` URL replacement
 * (`.convex.cloud → .convex.site`) is intentionally NOT mocked away —
 * we want to see the real URL the CLI builds in the error message,
 * which is what users will copy/paste into bug reports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClerkSessionExpiredError, ConvexEndpointNotFoundError, mintConvexJwt } from '../../src/auth/clerkFapi'
import type { SessionState } from '../../src/auth/session'

const FOREIGN_CONVEX_URL = 'https://foreign-project-13.convex.cloud'

function stubSession(): SessionState {
  return {
    version: 1,
    clerkSessionId: 'sess_user_who_ran_from_wrong_dir',
    clerkSessionToken: 'long-lived-clerk-jwt',
    convexJwt: '',
    convexJwtExpiry: 0,
    frontendApiUrl: 'https://prod.clerk.accounts.dev',
    convexUrl: FOREIGN_CONVEX_URL,
    issuedAt: Math.floor(Date.now() / 1000),
  }
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Scenario — mintConvexJwt surfaces wrong-deployment 404 as ConvexEndpointNotFoundError', () => {
  it('404 + "No matching routes found" → ConvexEndpointNotFoundError with URL + .env.local hint', async () => {
    // The exact body Convex's HTTP router returns when there is no route
    // for `/api/cli/mint-token`. Captured from a real production failure.
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response('No matching routes found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        })
      )
    ) as unknown as typeof fetch

    let caught: unknown
    try {
      await mintConvexJwt(stubSession())
    } catch (err) {
      caught = err
    }

    // INVARIANT 1: the new class fires.
    expect(caught).toBeInstanceOf(ConvexEndpointNotFoundError)
    // INVARIANT 2: it is NOT the legacy class (so the login.ts catch
    // chain dispatches on `ConvexEndpointNotFoundError` first and only
    // falls through to `ClerkSessionExpiredError` for a real expired
    // session). Class hierarchy contract.
    expect(caught).not.toBeInstanceOf(ClerkSessionExpiredError)

    // INVARIANT 3: the error surface carries the URL + body for
    // diagnostic display.
    const err = caught as ConvexEndpointNotFoundError
    // The CLI converts `.convex.cloud → .convex.site` before hitting the
    // route. The error message must surface that real URL so users can
    // verify which deployment was hit.
    expect(err.url).toBe(`${FOREIGN_CONVEX_URL.replace(/\.convex\.cloud$/, '.convex.site')}/api/cli/mint-token`)
    expect(err.body).toContain('No matching routes found')

    // INVARIANT 4: the message points at the most common cause
    // (`.env.local` in CWD overriding the baked CLI config) AND
    // surfaces the URL that was tried, so the user knows where to
    // look without filing a support ticket.
    expect(err.message).toContain(err.url)
    expect(err.message).toMatch(/\.env\.local/i)
  })

  it('404 + non-marker body → still ClerkSessionExpiredError (legacy behavior preserved)', async () => {
    // Make sure the new branch is conservative: it only fires on the
    // exact body marker. A 404 with an arbitrary body (e.g. from the
    // Clerk JWT template missing) still surfaces as a session-expired
    // prompt so we don't spam users with "wrong deployment" false
    // positives.
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response('JWT template "convex" not found', { status: 404 }))
    ) as unknown as typeof fetch

    let caught: unknown
    try {
      await mintConvexJwt(stubSession())
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ClerkSessionExpiredError)
    expect(caught).not.toBeInstanceOf(ConvexEndpointNotFoundError)
  })
})
