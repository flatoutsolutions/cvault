/**
 * Spec: §7 — Convex client wrapper with auto-access-token-refresh on 401.
 *
 * The wrapper holds a `ConvexHttpClient`, the persisted `SessionState`, and
 * a single retry policy: any 401 / "Not authenticated" / "Unauthenticated"
 * error triggers an OAuth refresh call, then the original op is retried once.
 * Subsequent 401s propagate untouched (user must re-run `cvault login`).
 *
 * Tests stub `ConvexHttpClient` methods + `refreshAccessToken` so we never
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
// auth-retry test runs. The mock must be hoisted by vitest
// (`vi.mock` runs before the import below).
vi.mock('../../src/auth/session', async () => {
  const actual = await vi.importActual<typeof import('../../src/auth/session')>('../../src/auth/session')
  return {
    ...actual,
    writeSession: vi.fn().mockResolvedValue(undefined),
  }
})

const sampleSession: SessionState = {
  version: 2,
  accessToken: 'access-token-old',
  accessTokenExpiry: Math.floor(Date.now() / 1000) + 900,
  refreshToken: 'refresh-token-old',
  // Convex is authenticated with the ID token (it carries `aud` = OAuth Client
  // ID; the access token does not). See VaultClient.buildDefaultClient.
  idToken: 'id-token-old',
  frontendApiUrl: 'https://clear-redbird-6.clerk.accounts.dev',
  clientId: 'client_test_123',
  convexUrl: 'https://beloved-mouse-707.convex.cloud',
}

const TEST_MACHINE_ID = 'machine-uuid-1234-5678'

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
  // the cached access token becomes a hard error the moment it lapses.
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

  function buildClient(session: SessionState = sampleSession, machineId = TEST_MACHINE_ID): VaultClient {
    // Dependency-injected client — production builds the real
    // `ConvexHttpClient`; tests inject this fake to avoid the network.
    return new VaultClient(session, machineId, {
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

  it('retries once on auth error after refreshing, re-authing Convex with the new ID token', async () => {
    queryStub.mockRejectedValueOnce(new Error('401 Unauthenticated')).mockResolvedValueOnce(['sub1'])

    // Stub refreshAccessToken by injecting a custom refresher.
    const refresher = vi.fn().mockResolvedValueOnce({
      accessToken: 'access-token-new',
      accessTokenExpiry: Math.floor(Date.now() / 1000) + 900,
      refreshToken: 'refresh-token-new',
      idToken: 'id-token-new',
    })
    const session = { ...sampleSession }
    const client = new VaultClient(
      session,
      TEST_MACHINE_ID,
      {
        query: queryStub as never,
        mutation: mutationStub as never,
        action: actionStub as never,
        setAuth: setAuthStub as never,
      },
      { refreshAccessToken: refresher }
    )

    const result = (await client.query(fakeQuery, {})) as string[]
    expect(result).toEqual(['sub1'])
    expect(refresher).toHaveBeenCalledTimes(1)
    // Refresher is called with the session's OAuth params
    expect(refresher).toHaveBeenCalledWith({
      frontendApiUrl: sampleSession.frontendApiUrl,
      clientId: sampleSession.clientId,
      refreshToken: sampleSession.refreshToken,
    })
    // Convex is re-authed with the refreshed ID token (not the access token).
    expect(setAuthStub).toHaveBeenCalledWith('id-token-new')
    expect(queryStub).toHaveBeenCalledTimes(2)
  })

  it('persists the rotated refresh token after a successful refresh', async () => {
    const { writeSession } = await import('../../src/auth/session')
    const writeSessionMock = vi.mocked(writeSession)
    writeSessionMock.mockClear()

    queryStub.mockRejectedValueOnce(new Error('401 Unauthenticated')).mockResolvedValueOnce(['sub1'])

    const rotatedRefreshToken = 'refresh-token-rotated'
    const refresher = vi.fn().mockResolvedValueOnce({
      accessToken: 'access-token-new',
      accessTokenExpiry: Math.floor(Date.now() / 1000) + 900,
      refreshToken: rotatedRefreshToken,
    })
    const client = new VaultClient(
      { ...sampleSession },
      TEST_MACHINE_ID,
      {
        query: queryStub as never,
        mutation: mutationStub as never,
        action: actionStub as never,
        setAuth: setAuthStub as never,
      },
      { refreshAccessToken: refresher }
    )

    await client.query(fakeQuery, {})

    // writeSession must have been called with the rotated refresh token
    expect(writeSessionMock).toHaveBeenCalled()
    const persistedSession = writeSessionMock.mock.calls[0]?.[0]
    expect(persistedSession?.refreshToken).toBe(rotatedRefreshToken)
    expect(persistedSession?.accessToken).toBe('access-token-new')
  })

  it('does not retry twice when the refresh-then-retry also fails with auth', async () => {
    queryStub
      .mockRejectedValueOnce(new Error('401 Unauthenticated'))
      .mockRejectedValueOnce(new Error('401 Unauthenticated again'))

    const refresher = vi.fn().mockResolvedValueOnce({
      accessToken: 'access-token-new',
      accessTokenExpiry: Math.floor(Date.now() / 1000) + 900,
      refreshToken: 'refresh-token-new',
    })

    const client = new VaultClient(
      { ...sampleSession },
      TEST_MACHINE_ID,
      {
        query: queryStub as never,
        mutation: mutationStub as never,
        action: actionStub as never,
        setAuth: setAuthStub as never,
      },
      { refreshAccessToken: refresher }
    )

    await expect(client.query(fakeQuery, {})).rejects.toThrow(/again/)
    expect(queryStub).toHaveBeenCalledTimes(2)
    expect(refresher).toHaveBeenCalledTimes(1)
  })
})

/**
 * `machineLabel` propagation: VaultClient exposes the session's
 * machineLabel via a getter and a `withMachineLabel(args)` helper that
 * merges it into action/mutation arg objects.
 */
describe('VaultClient.withMachineLabel', () => {
  it('exposes the session machineLabel via a getter', () => {
    const client = new VaultClient(
      { ...sampleSession, machineLabel: 'office-mac' },
      TEST_MACHINE_ID,
      {
        query: vi.fn() as never,
        mutation: vi.fn() as never,
        action: vi.fn() as never,
        setAuth: vi.fn() as never,
      }
    )
    expect(client.machineLabel).toBe('office-mac')
  })

  it('returns undefined when the session has no label', () => {
    const client = new VaultClient(sampleSession, TEST_MACHINE_ID, {
      query: vi.fn() as never,
      mutation: vi.fn() as never,
      action: vi.fn() as never,
      setAuth: vi.fn() as never,
    })
    expect(client.machineLabel).toBeUndefined()
  })

  it('merges the label into args when present', () => {
    const client = new VaultClient(
      { ...sampleSession, machineLabel: 'air-13' },
      TEST_MACHINE_ID,
      {
        query: vi.fn() as never,
        mutation: vi.fn() as never,
        action: vi.fn() as never,
        setAuth: vi.fn() as never,
      }
    )
    const merged = client.withMachineLabel({ slot: 1, force: true })
    expect(merged).toEqual({ slot: 1, force: true, machineLabel: 'air-13' })
  })

  it('returns the args unchanged when no label is present', () => {
    const client = new VaultClient(sampleSession, TEST_MACHINE_ID, {
      query: vi.fn() as never,
      mutation: vi.fn() as never,
      action: vi.fn() as never,
      setAuth: vi.fn() as never,
    })
    const args = { slot: 1 }
    const merged = client.withMachineLabel(args)
    // Neither the merged object nor the original should carry a label.
    expect(merged).toEqual({ slot: 1 })
    expect((merged as { machineLabel?: string }).machineLabel).toBeUndefined()
  })

  it('does not mutate the original args object', () => {
    const client = new VaultClient(
      { ...sampleSession, machineLabel: 'air-13' },
      TEST_MACHINE_ID,
      {
        query: vi.fn() as never,
        mutation: vi.fn() as never,
        action: vi.fn() as never,
        setAuth: vi.fn() as never,
      }
    )
    const args = { slot: 1 }
    client.withMachineLabel(args)
    expect((args as { machineLabel?: string }).machineLabel).toBeUndefined()
  })
})

/**
 * `withMeta` injects both `machineId` and optional `machineLabel`.
 */
describe('VaultClient.withMeta', () => {
  it('injects machineId into args', () => {
    const client = new VaultClient(sampleSession, TEST_MACHINE_ID, {
      query: vi.fn() as never,
      mutation: vi.fn() as never,
      action: vi.fn() as never,
      setAuth: vi.fn() as never,
    })
    const merged = client.withMeta({ slot: 1 })
    expect(merged.machineId).toBe(TEST_MACHINE_ID)
    expect(merged.slot).toBe(1)
  })

  it('injects machineId + machineLabel when label is present', () => {
    const client = new VaultClient(
      { ...sampleSession, machineLabel: 'my-laptop' },
      TEST_MACHINE_ID,
      {
        query: vi.fn() as never,
        mutation: vi.fn() as never,
        action: vi.fn() as never,
        setAuth: vi.fn() as never,
      }
    )
    const merged = client.withMeta({ slot: 2 })
    expect(merged.machineId).toBe(TEST_MACHINE_ID)
    expect(merged.machineLabel).toBe('my-laptop')
    expect(merged.slot).toBe(2)
  })

  it('does not add machineLabel when not set on session', () => {
    const client = new VaultClient(sampleSession, TEST_MACHINE_ID, {
      query: vi.fn() as never,
      mutation: vi.fn() as never,
      action: vi.fn() as never,
      setAuth: vi.fn() as never,
    })
    const merged = client.withMeta({})
    expect(merged.machineId).toBe(TEST_MACHINE_ID)
    expect((merged as { machineLabel?: string }).machineLabel).toBeUndefined()
  })
})
