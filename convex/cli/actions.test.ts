/**
 * Spec: §7 (CLI auth flow), per docs/research/clerk-convex-tanstack-integration.md.
 *
 * `cli.startLink` is invoked from the dashboard when the CLI sends the user
 * over to `/cli/link?state=<nonce>`. It uses ctx.auth.getUserIdentity() to
 * confirm the human is the one signed into the dashboard, then mints a
 * single-use Clerk sign-in token for that user_id and returns it. The
 * dashboard then POSTs the token to the localhost listener.
 *
 * The Clerk Backend API call is mocked via the `__setClerkFetch` test seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../_generated/api'
import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { __setClerkFetch } from './clerk'

const ORIGINAL_CLERK_KEY = process.env.CLERK_SECRET_KEY

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = 'sk_test_dummy_for_unit_tests'
})

afterEach(() => {
  if (ORIGINAL_CLERK_KEY === undefined) {
    delete process.env.CLERK_SECRET_KEY
  } else {
    process.env.CLERK_SECRET_KEY = ORIGINAL_CLERK_KEY
  }
  __setClerkFetch(undefined)
})

describe('cli.actions.startLink', () => {
  it('throws when called without a Clerk identity', async () => {
    const t = vault()
    await expect(
      t.action(api.cli.actions.startLink, { state: 'abc' })
    ).rejects.toThrow(/authenticated/i)
  })

  it('mints a sign-in token from Clerk Backend API and returns it to the caller', async () => {
    const t = vault()
    await seedUser(t)

    const fetchStub = vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe('https://api.clerk.com/v1/sign_in_tokens')
      expect(init.method).toBe('POST')
      expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer sk_test_/)
      // body is always a string in our action's outgoing fetch().
      const bodyStr = typeof init.body === 'string' ? init.body : ''
      const body = JSON.parse(bodyStr) as { user_id?: string; expires_in_seconds?: number }
      // Confirms the action passes through the Clerk subject as user_id.
      expect(body.user_id).toBe(TEST_IDENTITY.subject)
      // Per spec: short TTL for CLI link (the brief recommends 600s).
      expect(body.expires_in_seconds).toBeLessThanOrEqual(900)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: 'sign_in_token',
            id: 'sit_1234567',
            token: 'CLERK_SIGN_IN_TOKEN_OPAQUE_VALUE',
            status: 'pending',
            user_id: TEST_IDENTITY.subject,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    __setClerkFetch(fetchStub as unknown as typeof fetch)

    const result = await t.withIdentity(TEST_IDENTITY).action(api.cli.actions.startLink, {
      state: 'nonce-abc-123',
    })
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(result.signInToken).toBe('CLERK_SIGN_IN_TOKEN_OPAQUE_VALUE')
  })

  it('surfaces a Clerk Backend API error as a ConvexError', async () => {
    const t = vault()
    await seedUser(t)

    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ errors: [{ message: 'rate limited' }] }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      )
    )

    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.cli.actions.startLink, { state: 'x' })
    ).rejects.toThrow(/clerk/i)
  })

  it('throws if CLERK_SECRET_KEY is not set on the deployment', async () => {
    const t = vault()
    await seedUser(t)

    delete process.env.CLERK_SECRET_KEY
    __setClerkFetch(vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))))

    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.cli.actions.startLink, { state: 'x' })
    ).rejects.toThrow(/CLERK_SECRET_KEY/)
  })
})

describe('cli.actions.revokeSession', () => {
  it('throws when called without a Clerk identity', async () => {
    const t = vault()
    await expect(
      t.action(api.cli.actions.revokeSession, { clerkSessionId: 'sess_x' })
    ).rejects.toThrow(/authenticated/i)
  })

  it('calls Clerk to load the session, verifies ownership, then revokes', async () => {
    const t = vault()
    await seedUser(t)

    const fetchStub = vi.fn((url: string, init: RequestInit) => {
      // Step 1: GET the session by id to learn its user_id.
      if (url === 'https://api.clerk.com/v1/sessions/sess_target_xyz') {
        expect(init.method ?? 'GET').toBe('GET')
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'sess_target_xyz',
              user_id: TEST_IDENTITY.subject,
              status: 'active',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      }
      // Step 2: POST to revoke once ownership is confirmed.
      if (url === 'https://api.clerk.com/v1/sessions/sess_target_xyz/revoke') {
        expect(init.method).toBe('POST')
        expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer sk_test_/)
        return Promise.resolve(
          new Response(
            JSON.stringify({ id: 'sess_target_xyz', status: 'revoked' }),
            { status: 200 }
          )
        )
      }
      throw new Error(`unexpected fetch URL: ${url}`)
    })
    __setClerkFetch(fetchStub as unknown as typeof fetch)

    const result = await t.withIdentity(TEST_IDENTITY).action(api.cli.actions.revokeSession, {
      clerkSessionId: 'sess_target_xyz',
    })
    // Two calls: the lookup, then the revoke.
    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(result.revoked).toBe(true)
  })

  it('rejects revoke when the caller does not own the target session', async () => {
    const t = vault()
    await seedUser(t)

    const fetchStub = vi.fn((url: string) => {
      if (url === 'https://api.clerk.com/v1/sessions/sess_bob_xyz') {
        // Clerk reports the session belongs to a DIFFERENT user.
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'sess_bob_xyz',
              user_id: 'user_test_bob',
              status: 'active',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      }
      throw new Error(`unexpected fetch URL: ${url}`)
    })
    __setClerkFetch(fetchStub as unknown as typeof fetch)

    // Alice tries to revoke a session owned by Bob.
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.cli.actions.revokeSession, {
        clerkSessionId: 'sess_bob_xyz',
      })
    ).rejects.toThrow(/not found|not owned/i)

    // Critically: revoke endpoint must NOT be called.
    const calls = fetchStub.mock.calls.map((c) => c[0])
    expect(calls).not.toContain('https://api.clerk.com/v1/sessions/sess_bob_xyz/revoke')
    // Only the lookup happened.
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('rejects revoke when Clerk returns 404 for the session lookup', async () => {
    const t = vault()
    await seedUser(t)

    const fetchStub = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ errors: [{ message: 'not found' }] }), { status: 404 })
      )
    )
    __setClerkFetch(fetchStub as unknown as typeof fetch)

    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.cli.actions.revokeSession, {
        clerkSessionId: 'sess_unknown',
      })
    ).rejects.toThrow(/not found|not owned/i)
    // Only the lookup happened; no revoke attempt.
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })
})
