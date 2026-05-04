import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'
import { __setClerkFetch } from './clerk'

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
  vi.restoreAllMocks()
})

function mockVerify(payload: object) {
  verifyTokenMock.mockResolvedValue(payload as never)
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
    await expect(t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'tok' })).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )
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
})
