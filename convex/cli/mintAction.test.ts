import type { ClerkClient } from '@clerk/backend'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'
import { __setClerkBackendClientFactory, __setClerkFetch } from './clerk'

// Hoisted mock for @clerk/backend so verifyToken can be controlled per-test.
// vi.spyOn() doesn't work with ESM module namespaces in edge-runtime, so we
// use vi.mock() factory + a mutable reference instead.
const verifyTokenMock = vi.hoisted(() => vi.fn())
vi.mock('@clerk/backend', async () => {
  const actual = await vi.importActual<typeof import('@clerk/backend')>('@clerk/backend')
  return {
    ...actual,
    verifyToken: verifyTokenMock,
  }
})

const ORIG = process.env.CLERK_SECRET_KEY

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = 'sk_test_dummy'
  verifyTokenMock.mockReset()
})

afterEach(() => {
  if (ORIG === undefined) delete process.env.CLERK_SECRET_KEY
  else process.env.CLERK_SECRET_KEY = ORIG
  __setClerkFetch(undefined)
  __setClerkBackendClientFactory(undefined)
  vi.restoreAllMocks()
})

function mockVerify(payload: object) {
  verifyTokenMock.mockResolvedValue(payload as never)
}

/**
 * Build a stub ClerkClient whose `users.getUser` is the supplied mock.
 * The cast is intentional and narrow: the test only ever exercises
 * `users.getUser`, so we don't need a faithful full-surface fake.
 */
function stubClerkBackendClient(getUser: ReturnType<typeof vi.fn>): ClerkClient {
  return {
    users: { getUser },
  } as unknown as ClerkClient
}

describe('cli.mintAction.mintConvexJwt — domain gate', () => {
  it('mints when bootstrap-allowed email', async () => {
    const t = vault()
    mockVerify({ sid: 'sess', sub: 'user_a', email: 'alice@flatout.solutions' })
    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'fake-jwt' }), { status: 200 }))
      ) as unknown as typeof fetch
    )
    const result = await t.action(internal.cli.mintAction.mintConvexJwt, {
      clerkSessionToken: 'tok',
    })
    expect(result.jwt).toBe('fake-jwt')
  })

  it('rejects wrong-domain email', async () => {
    const t = vault()
    mockVerify({ sid: 'sess', sub: 'user_b', email: 'bob@gmail.com' })
    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'should-not' }), { status: 200 }))
      ) as unknown as typeof fetch
    )
    await expect(t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'tok' })).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )
  })

  it('rejects no-email payload', async () => {
    const t = vault()
    mockVerify({ sid: 'sess', sub: 'user_x' })
    __setClerkFetch(vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))) as unknown as typeof fetch)
    // Real Clerk session JWTs have no `email` claim, so the gate must
    // fall back to BAPI. Stub a wrong-domain primary email so the gate
    // still rejects — proving the fallback is wired AND still enforces.
    const getUser = vi.fn(() => Promise.resolve({ primaryEmailAddress: { emailAddress: 'bob@gmail.com' } } as never))
    __setClerkBackendClientFactory(() => stubClerkBackendClient(getUser))
    await expect(t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'tok' })).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )
    expect(getUser).toHaveBeenCalledWith('user_x')
  })

  it('falls back to BAPI when JWT lacks email claim and mints when allowed', async () => {
    const t = vault()
    // Realistic Clerk session-token payload: `azp/exp/iat/iss/jti/nbf/sub`
    // and `sid` for our verifyToken consumers — but NO `email` claim.
    // (See Clerk session-token reference; the `convex` template adds
    // `email`, the default session token does not.)
    mockVerify({ sid: 'sess', sub: 'user_real' })
    const getUser = vi.fn(() =>
      Promise.resolve({
        primaryEmailAddress: { emailAddress: 'saad@flatout.solutions' },
      } as never)
    )
    __setClerkBackendClientFactory(() => stubClerkBackendClient(getUser))
    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'fake-jwt-after-bapi' }), { status: 200 }))
      ) as unknown as typeof fetch
    )
    const result = await t.action(internal.cli.mintAction.mintConvexJwt, {
      clerkSessionToken: 'tok',
    })
    expect(result.jwt).toBe('fake-jwt-after-bapi')
    expect(getUser).toHaveBeenCalledTimes(1)
    expect(getUser).toHaveBeenCalledWith('user_real')
  })

  it('wraps BAPI getUser failure as CLERK_BACKEND_ERROR', async () => {
    const t = vault()
    mockVerify({ sid: 'sess', sub: 'user_boom' })
    const getUser = vi.fn(() => Promise.reject(new Error('BAPI 500: upstream unavailable')))
    __setClerkBackendClientFactory(() => stubClerkBackendClient(getUser))
    __setClerkFetch(vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))) as unknown as typeof fetch)
    await expect(t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'tok' })).rejects.toThrow(
      /CLERK_BACKEND_ERROR|BAPI/i
    )
    expect(getUser).toHaveBeenCalledWith('user_boom')
  })

  it('accepts an added (non-bootstrap) domain', async () => {
    const t = vault()
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmailDomains', { domain: 'acme.com', addedAtMs: 1 })
    })
    mockVerify({ sid: 'sess', sub: 'user_c', email: 'carol@acme.com' })
    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'jwt-acme' }), { status: 200 }))
      ) as unknown as typeof fetch
    )
    const result = await t.action(internal.cli.mintAction.mintConvexJwt, {
      clerkSessionToken: 'tok',
    })
    expect(result.jwt).toBe('jwt-acme')
  })

  it('mints when identity is matched only via allowedEmails (not via domain) — JWT-claim path', async () => {
    const t = vault()
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
    })
    mockVerify({ sid: 'sess_x', sub: 'user_samuel', email: 'samuel.asseg@gmail.com' })
    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'jwt-explicit-email' }), { status: 200 }))
      ) as unknown as typeof fetch
    )
    const result = await t.action(internal.cli.mintAction.mintConvexJwt, {
      clerkSessionToken: 'tok',
    })
    expect(result.jwt).toBe('jwt-explicit-email')
  })

  it('mints via BAPI fallback when JWT lacks email and the resolved primary is on allowedEmails', async () => {
    const t = vault()
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
    })
    mockVerify({ sid: 'sess_x', sub: 'user_samuel' })
    const getUser = vi.fn(() =>
      Promise.resolve({ primaryEmailAddress: { emailAddress: 'samuel.asseg@gmail.com' } } as never)
    )
    __setClerkBackendClientFactory(() => stubClerkBackendClient(getUser))
    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'jwt-bapi-explicit' }), { status: 200 }))
      ) as unknown as typeof fetch
    )
    const result = await t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'tok' })
    expect(result.jwt).toBe('jwt-bapi-explicit')
    expect(getUser).toHaveBeenCalledWith('user_samuel')
  })
})
