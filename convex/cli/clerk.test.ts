/**
 * Unit tests for `createSessionTokenFromTemplate`.
 *
 * The interesting bit is the `expires_in_seconds` default: changed from
 * 1 hour (3600s) to 30 days (2592000s) so the CLI re-mints far less often.
 * Clerk BAPI accepts up to 315360000 (10 years), so 30 days is well
 * within bounds.
 *
 * We mock the outgoing `fetch` via `__setClerkFetch` so we can assert on
 * the request body without hitting api.clerk.com.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __setClerkFetch, createSessionTokenFromTemplate } from './clerk'

const ORIG = process.env.CLERK_SECRET_KEY

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = 'sk_test_clerktest'
})

afterEach(() => {
  if (ORIG === undefined) delete process.env.CLERK_SECRET_KEY
  else process.env.CLERK_SECRET_KEY = ORIG
  __setClerkFetch(undefined)
})

/**
 * Helper: run `createSessionTokenFromTemplate` against a captured-fetch
 * stub and return whatever request body was sent. The stub always
 * resolves a 200 with a fake jwt.
 */
async function captureRequestBody(options?: {
  expiresInSeconds?: number
}): Promise<{ body: { expires_in_seconds: number }; url: string }> {
  let captured: { url: string; body: string } | null = null
  const stub = vi.fn((url: string, init: RequestInit) => {
    captured = { url, body: typeof init.body === 'string' ? init.body : '' }
    return Promise.resolve(
      new Response(JSON.stringify({ jwt: 'fake-template-jwt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  })
  __setClerkFetch(stub as unknown as typeof fetch)

  const result = options
    ? await createSessionTokenFromTemplate('sess_x', 'convex', options)
    : await createSessionTokenFromTemplate('sess_x', 'convex')
  expect(result.ok).toBe(true)
  expect(captured).not.toBeNull()
  if (captured === null) throw new Error('unreachable')
  // Vitest `expect(captured).not.toBeNull()` doesn't narrow the const
  // back to non-null, so we re-bind through a local variable to avoid
  // the persistent never-narrowed inference.
  const { url, body }: { url: string; body: string } = captured
  return { url, body: JSON.parse(body) as { expires_in_seconds: number } }
}

describe('createSessionTokenFromTemplate — expires_in_seconds default', () => {
  it('defaults to 30 days (2_592_000 seconds) when no option is supplied', async () => {
    // Regression test for the lifetime change. The old default was 3600s
    // (1 hour) which forced a Convex round-trip every hour from the CLI.
    // 30 days strikes a better tradeoff for a long-running CLI.
    const { body } = await captureRequestBody()
    expect(body.expires_in_seconds).toBe(2_592_000)
  })

  it('respects an explicit override (lower)', async () => {
    const { body } = await captureRequestBody({ expiresInSeconds: 60 })
    expect(body.expires_in_seconds).toBe(60)
  })

  it('respects an explicit override (higher)', async () => {
    const { body } = await captureRequestBody({ expiresInSeconds: 86_400 })
    expect(body.expires_in_seconds).toBe(86_400)
  })

  it('hits the BAPI session-template endpoint with the supplied template name', async () => {
    const { url } = await captureRequestBody()
    expect(url).toBe('https://api.clerk.com/v1/sessions/sess_x/tokens/convex')
  })
})
