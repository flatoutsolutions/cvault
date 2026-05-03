/**
 * Spec: §7 — Convex client wrapper with auto-JWT-refresh on 401.
 *
 * The wrapper holds a `ConvexHttpClient`, the persisted `SessionState`, and
 * a single retry policy: any 401 / "Not authenticated" / "Unauthenticated"
 * error triggers a fresh `mintConvexJwt` call, then the original op is
 * retried once. Subsequent 401s propagate untouched (long-lived Clerk
 * session is dead → user must re-run `cvault login`).
 *
 * Tests stub `ConvexHttpClient` methods + `mintConvexJwt` so we never
 * actually hit the network.
 */
import type { FunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionState } from '../../src/auth/session'
import { isAuthError } from '../../src/convex/isAuthError'
import { VaultClient } from '../../src/convex/vaultClient'

// CRITICAL: VaultClient.refreshAuth() persists the refreshed session to
// `~/.vault/session.json` via writeSession. Without this mock the tests
// would clobber the developer's REAL session file every time the
// auth-retry test runs (verified empirically: a corrupted session.json
// containing test fixtures like `clerkSessionToken: "session-jwt"` was
// observed on a developer's machine). The mock must be hoisted by vitest
// (`vi.mock` runs before the import below).
vi.mock('../../src/auth/session', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/session')>('../../src/auth/session')
  return {
    ...actual,
    writeSession: vi.fn().mockResolvedValue(undefined),
  }
})

const sampleSession: SessionState = {
  version: 1,
  clerkSessionId: 'sess_abc',
  clerkSessionToken: 'session-jwt',
  convexJwt: 'jwt-old',
  convexJwtExpiry: 0,
  frontendApiUrl: 'https://clear-redbird-6.clerk.accounts.dev',
  convexUrl: 'https://beloved-mouse-707.convex.cloud',
  issuedAt: 1_700_000_000,
}

// Generic FunctionReference-shaped fake for tests.
const fakeQuery = ((): FunctionReference<'query'> => {
  const target = {}
  const proxy = new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString') {
        return () => 'subscriptions/queries:listForUser'
      }
      return undefined
    },
  })
  return proxy as FunctionReference<'query'>
})()

const fakeMutation = ((): FunctionReference<'mutation'> => {
  return new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === Symbol.toPrimitive || prop === 'toString' ? () => 'subscriptions/mutations:softRemove' : undefined,
    }
  ) as FunctionReference<'mutation'>
})()

const fakeAction = ((): FunctionReference<'action'> => {
  return new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === Symbol.toPrimitive || prop === 'toString' ? () => 'subscriptions/actions:pullForSwitch' : undefined,
    }
  ) as FunctionReference<'action'>
})()

describe('isAuthError', () => {
  it('matches plain Error with "401" in the message', () => {
    expect(isAuthError(new Error('Server error: 401 Unauthorized'))).toBe(true)
  })

  it('matches plain Error with "Unauthenticated"', () => {
    expect(isAuthError(new Error('Unauthenticated request'))).toBe(true)
  })

  it('matches plain Error with "Not authenticated"', () => {
    expect(isAuthError(new Error('Not authenticated'))).toBe(true)
  })

  // Convex's auth-rejection codes. These must trigger a refresh; otherwise
  // the cached 60-second convex JWT becomes a hard error the moment it
  // lapses (verified end-to-end against the live deployment).
  it('matches Convex InvalidAuthHeader / could-not-parse-JWT errors', () => {
    expect(isAuthError(new Error('{"code":"InvalidAuthHeader","message":"Could not parse JWT payload."}'))).toBe(true)
    expect(isAuthError(new Error('InvalidAuthToken: signature verification failed'))).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isAuthError(new Error('Something else'))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isAuthError('plain string')).toBe(false)
    expect(isAuthError(undefined)).toBe(false)
    expect(isAuthError(null)).toBe(false)
  })
})

describe('VaultClient', () => {
  let queryStub: ReturnType<typeof vi.fn>
  let mutationStub: ReturnType<typeof vi.fn>
  let actionStub: ReturnType<typeof vi.fn>
  let setAuthStub: ReturnType<typeof vi.fn>

  beforeEach(() => {
    queryStub = vi.fn()
    mutationStub = vi.fn()
    actionStub = vi.fn()
    setAuthStub = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function buildClient(session: SessionState = sampleSession): VaultClient {
    // Dependency-injected client — production builds the real
    // `ConvexHttpClient`; tests inject this fake to avoid the network.
    return new VaultClient(session, {
      query: queryStub as never,
      mutation: mutationStub as never,
      action: actionStub as never,
      setAuth: setAuthStub as never,
    })
  }

  it('forwards query to the underlying ConvexHttpClient', async () => {
    queryStub.mockResolvedValueOnce(['sub1', 'sub2'])
    const client = buildClient()
    const result = (await client.query(fakeQuery, {})) as string[]
    expect(result).toEqual(['sub1', 'sub2'])
    expect(queryStub).toHaveBeenCalledWith(fakeQuery, {})
  })

  it('forwards mutation to the underlying ConvexHttpClient', async () => {
    mutationStub.mockResolvedValueOnce(null)
    const client = buildClient()
    await client.mutation(fakeMutation, { email: 'a@b.com' })
    expect(mutationStub).toHaveBeenCalledWith(fakeMutation, { email: 'a@b.com' })
  })

  it('forwards action to the underlying ConvexHttpClient', async () => {
    actionStub.mockResolvedValueOnce({ email: 'a@b.com', plaintextBlob: '{}' })
    const client = buildClient()
    const result = (await client.action(fakeAction, { slotOrEmail: '1' })) as {
      email: string
      plaintextBlob: string
    }
    expect(result).toEqual({ email: 'a@b.com', plaintextBlob: '{}' })
  })

  it('non-auth errors propagate without retry', async () => {
    queryStub.mockRejectedValueOnce(new Error('something went wrong'))
    const client = buildClient()
    await expect(client.query(fakeQuery, {})).rejects.toThrow(/something went wrong/)
    expect(queryStub).toHaveBeenCalledTimes(1)
  })

  it('retries once on auth error after refreshing the JWT', async () => {
    queryStub.mockRejectedValueOnce(new Error('401 Unauthenticated')).mockResolvedValueOnce(['sub1'])

    // Stub mintConvexJwt by injecting a custom refresher.
    const refresher = vi.fn().mockResolvedValueOnce({
      convexJwt: 'jwt-new',
      convexJwtExpiry: 1_700_000_999,
    })
    const session = { ...sampleSession }
    const client = new VaultClient(
      session,
      {
        query: queryStub as never,
        mutation: mutationStub as never,
        action: actionStub as never,
        setAuth: setAuthStub as never,
      },
      { refreshJwt: refresher }
    )

    const result = (await client.query(fakeQuery, {})) as string[]
    expect(result).toEqual(['sub1'])
    expect(refresher).toHaveBeenCalledTimes(1)
    expect(setAuthStub).toHaveBeenCalledWith('jwt-new')
    expect(queryStub).toHaveBeenCalledTimes(2)
  })

  it('does not retry twice when the refresh-then-retry also fails with auth', async () => {
    queryStub
      .mockRejectedValueOnce(new Error('401 Unauthenticated'))
      .mockRejectedValueOnce(new Error('401 Unauthenticated again'))

    const refresher = vi.fn().mockResolvedValueOnce({
      convexJwt: 'jwt-new',
      convexJwtExpiry: 1_700_000_999,
    })

    const client = new VaultClient(
      { ...sampleSession },
      {
        query: queryStub as never,
        mutation: mutationStub as never,
        action: actionStub as never,
        setAuth: setAuthStub as never,
      },
      { refreshJwt: refresher }
    )

    await expect(client.query(fakeQuery, {})).rejects.toThrow(/again/)
    expect(queryStub).toHaveBeenCalledTimes(2)
    expect(refresher).toHaveBeenCalledTimes(1)
  })
})
