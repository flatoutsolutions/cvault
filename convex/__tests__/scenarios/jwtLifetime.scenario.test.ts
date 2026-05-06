/**
 * Scenario — Clerk template JWT default lifetime is 30 days.
 *
 * Background:
 *   `createSessionTokenFromTemplate` previously defaulted to a 1-hour
 *   `expires_in_seconds`. The Convex client mints a fresh JWT on every
 *   reconnect/expiry, so a 1-hour ceiling forced the CLI to round-trip
 *   through `/api/cli/mint-token` once an hour even on long-running
 *   commands. The shipped JWT lifetime trade-off is now: 30 days,
 *   well under Clerk BAPI's 10-year ceiling
 *   (`expires_in_seconds` max = 315360000).
 *
 *   See `convex/cli/clerk.ts:createSessionTokenFromTemplate` for the
 *   per-call override path used by tests + future tooling that wants
 *   a shorter window.
 *
 * What this scenario asserts (the END-TO-END BAPI request the CLI sees
 * when it asks Convex to mint a Clerk template JWT):
 *   1. Calling `createSessionTokenFromTemplate(sid, 'convex')` with no
 *      `expiresInSeconds` option produces a BAPI request body whose
 *      `expires_in_seconds` field is exactly `2_592_000` (30 days).
 *   2. Passing `{ expiresInSeconds: 60 }` overrides the default — the
 *      request body carries `60`, not `2_592_000`. (Forward-compat for
 *      tests/tooling.)
 *   3. The default is well under the Clerk BAPI ceiling so we never
 *      regress past the upstream limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __setClerkFetch, createSessionTokenFromTemplate } from '../../cli/clerk'

const ORIG_KEY = process.env.CLERK_SECRET_KEY

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = 'sk_test_jwtlifetime_scenario'
})

afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.CLERK_SECRET_KEY
  else process.env.CLERK_SECRET_KEY = ORIG_KEY
  __setClerkFetch(undefined)
})

/** Clerk BAPI's documented upper bound for `expires_in_seconds`. */
const BAPI_EXPIRES_IN_SECONDS_MAX = 315_360_000 // 10 years

/**
 * Run `createSessionTokenFromTemplate` against a stub fetch that records
 * the request body, returns a fake 200, and surfaces the captured body.
 */
async function captureMintRequest(options?: {
  expiresInSeconds?: number
}): Promise<{ body: { expires_in_seconds: number }; url: string }> {
  let captured: { url: string; body: string } | null = null
  __setClerkFetch(
    vi.fn((url: string, init: RequestInit) => {
      captured = { url, body: typeof init.body === 'string' ? init.body : '' }
      return Promise.resolve(
        new Response(JSON.stringify({ jwt: 'fake-template-jwt' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }) as unknown as typeof fetch
  )

  const result = options
    ? await createSessionTokenFromTemplate('sess_x', 'convex', options)
    : await createSessionTokenFromTemplate('sess_x', 'convex')
  expect(result.ok).toBe(true)
  expect(captured).not.toBeNull()
  if (captured === null) throw new Error('unreachable')
  const { url, body }: { url: string; body: string } = captured
  return { url, body: JSON.parse(body) as { expires_in_seconds: number } }
}

describe('Scenario — Clerk template JWT lifetime defaults to 30 days', () => {
  it('default expires_in_seconds === 2_592_000 (30 days)', async () => {
    const { body } = await captureMintRequest()
    expect(body.expires_in_seconds).toBe(2_592_000)
  })

  it('default is well under the Clerk BAPI ceiling (315_360_000)', async () => {
    const { body } = await captureMintRequest()
    expect(body.expires_in_seconds).toBeLessThan(BAPI_EXPIRES_IN_SECONDS_MAX)
  })

  it('explicit { expiresInSeconds: 60 } overrides the default', async () => {
    const { body } = await captureMintRequest({ expiresInSeconds: 60 })
    expect(body.expires_in_seconds).toBe(60)
  })

  it('hits the BAPI session-template endpoint with the supplied template name', async () => {
    const { url } = await captureMintRequest()
    expect(url).toBe('https://api.clerk.com/v1/sessions/sess_x/tokens/convex')
  })
})
