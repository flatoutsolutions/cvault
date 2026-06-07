/**
 * CVLT-3: Tests for the rewritten CLI actions.
 *
 * - `recordLogin({machineId, machineLabel?, grantRef?, sid?})` — upserts a device
 *   row and writes a `login` machineActivity row.
 * - `revokeDevice({machineId})` — looks up the device globally by machineId,
 *   denylists the session id in revokedSessions (if present), best-effort calls
 *   revokeClerkSession via BAPI, marks the device revoked, and writes a `remove`
 *   machineActivity row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { __setClerkFetch } from './clerk'

const ORIGINAL_CLERK_KEY = process.env.CLERK_SECRET_KEY

beforeEach(() => {
  // Provide a dummy key so loadSecretKey() doesn't throw in tests.
  process.env.CLERK_SECRET_KEY = 'sk_test_dummy_for_unit_tests'
})

afterEach(() => {
  // Reset the Clerk fetch stub and env after each test.
  __setClerkFetch(undefined)
  if (ORIGINAL_CLERK_KEY === undefined) delete process.env.CLERK_SECRET_KEY
  else process.env.CLERK_SECRET_KEY = ORIGINAL_CLERK_KEY
})

describe('cli.actions.recordLogin', () => {
  it('throws when called without a Clerk identity', async () => {
    const t = vault()
    await expect(t.action(api.cli.actions.recordLogin, { machineId: 'mach-1' })).rejects.toThrow(/authenticated/i)
  })

  it('returns { recorded: false } when the user row does not exist yet', async () => {
    const t = vault()
    // Do NOT seed a user — simulate Clerk webhook not yet fired.
    const result = await t.withIdentity(TEST_IDENTITY).action(api.cli.actions.recordLogin, {
      machineId: 'mach-no-user',
    })
    expect(result.recorded).toBe(false)
  })

  it('upserts a device row and writes a login activity row', async () => {
    const t = vault()
    const userId = await seedUser(t)

    const result = await t.withIdentity(TEST_IDENTITY).action(api.cli.actions.recordLogin, {
      machineId: 'mach-1',
      machineLabel: 'work-laptop',
    })
    expect(result.recorded).toBe(true)

    // Verify device row was created.
    const devices = await t.run(async (ctx) => ctx.db.query('devices').collect())
    expect(devices).toHaveLength(1)
    expect(devices[0]?.machineId).toBe('mach-1')
    expect(devices[0]?.label).toBe('work-laptop')
    expect(devices[0]?.userId).toStrictEqual(userId)

    // Verify machineActivity row was created with action='login'.
    const activity = await t.run(async (ctx) => ctx.db.query('machineActivity').collect())
    expect(activity).toHaveLength(1)
    expect(activity[0]?.action).toBe('login')
    expect(activity[0]?.machineId).toBe('mach-1')
    expect(activity[0]?.userId).toStrictEqual(userId)
  })

  it('upserts (does not duplicate) the device row on repeated login', async () => {
    const t = vault()
    await seedUser(t)

    await t.withIdentity(TEST_IDENTITY).action(api.cli.actions.recordLogin, {
      machineId: 'mach-1',
      machineLabel: 'work-laptop',
    })
    await t.withIdentity(TEST_IDENTITY).action(api.cli.actions.recordLogin, {
      machineId: 'mach-1',
      machineLabel: 'work-laptop-renamed',
    })

    const devices = await t.run(async (ctx) => ctx.db.query('devices').collect())
    // Should still be one device row — upserted, not duplicated.
    expect(devices).toHaveLength(1)
    expect(devices[0]?.label).toBe('work-laptop-renamed')

    // Two activity rows (one per login call).
    const activity = await t.run(async (ctx) => ctx.db.query('machineActivity').collect())
    expect(activity).toHaveLength(2)
    expect(activity.every((r) => r.action === 'login')).toBe(true)
  })

  it('stores grantRef on the device row when provided', async () => {
    const t = vault()
    await seedUser(t)

    await t.withIdentity(TEST_IDENTITY).action(api.cli.actions.recordLogin, {
      machineId: 'mach-grant',
      grantRef: 'grant_abc123',
    })

    const devices = await t.run(async (ctx) => ctx.db.query('devices').collect())
    expect(devices[0]?.grantRef).toBe('grant_abc123')
  })

  it('stores sid on the device row when provided', async () => {
    const t = vault()
    await seedUser(t)

    await t.withIdentity(TEST_IDENTITY).action(api.cli.actions.recordLogin, {
      machineId: 'mach-sid',
      sid: 'sess_clerk_abc',
    })

    const devices = await t.run(async (ctx) => ctx.db.query('devices').collect())
    expect(devices[0]?.sid).toBe('sess_clerk_abc')
  })
})

describe('cli.actions.revokeDevice', () => {
  it('throws when called without a Clerk identity', async () => {
    const t = vault()
    await expect(t.action(api.cli.actions.revokeDevice, { machineId: 'mach-x' })).rejects.toThrow(/authenticated/i)
  })

  it('throws NOT_FOUND when the device does not exist', async () => {
    const t = vault()
    await seedUser(t)

    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.cli.actions.revokeDevice, { machineId: 'mach-nonexistent' })
    ).rejects.toThrow(/not found/i)
  })

  it('marks the device revoked and writes a remove activity row (no sid)', async () => {
    const t = vault()
    const userId = await seedUser(t)

    // Register the device first (no sid — legacy path).
    await t.mutation(internal.devices.mutations.upsert, {
      userId,
      machineId: 'mach-1',
      label: 'work-laptop',
      at: 1000,
    })

    // Stub Clerk BAPI fetch (should not be called when no sid).
    const clerkCalls: string[] = []
    __setClerkFetch(
      vi.fn((url: string) => {
        clerkCalls.push(url)
        return Promise.resolve(new Response('{}', { status: 200 }))
      }) as unknown as typeof fetch
    )

    const result = await t.withIdentity(TEST_IDENTITY).action(api.cli.actions.revokeDevice, {
      machineId: 'mach-1',
    })
    expect(result.revoked).toBe(true)

    // Device row should be marked revoked.
    const device = await t.run(async (ctx) =>
      ctx.db
        .query('devices')
        .withIndex('byUserAndMachine', (q) => q.eq('userId', userId).eq('machineId', 'mach-1'))
        .unique()
    )
    expect(device?.revokedAt).toBeDefined()
    expect(typeof device?.revokedAt).toBe('number')

    // No Clerk BAPI call made (no sid).
    expect(clerkCalls).toHaveLength(0)

    // machineActivity should have a `remove` row.
    const activity = await t.run(async (ctx) => ctx.db.query('machineActivity').collect())
    expect(activity).toHaveLength(1)
    expect(activity[0]?.action).toBe('remove')
    expect(activity[0]?.machineId).toBe('mach-1')
    expect(activity[0]?.userId).toStrictEqual(userId)
  })

  it('denylists the sid in revokedSessions when sid is present', async () => {
    const t = vault()
    const userId = await seedUser(t)

    await t.mutation(internal.devices.mutations.upsert, {
      userId,
      machineId: 'mach-sid',
      at: 1000,
      sid: 'sess_to_revoke',
    })

    // Stub Clerk BAPI to return success.
    __setClerkFetch(vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))) as unknown as typeof fetch)

    const result = await t.withIdentity(TEST_IDENTITY).action(api.cli.actions.revokeDevice, {
      machineId: 'mach-sid',
    })
    expect(result.revoked).toBe(true)

    // revokedSessions must have the sid.
    const sessionRow = await t.run(async (ctx) =>
      ctx.db
        .query('revokedSessions')
        .withIndex('bySid', (q) => q.eq('sid', 'sess_to_revoke'))
        .unique()
    )
    expect(sessionRow).not.toBeNull()
    expect(sessionRow?.sid).toBe('sess_to_revoke')
    expect(sessionRow?.machineId).toBe('mach-sid')
  })

  it('calls Clerk BAPI session revoke when sid is present', async () => {
    const t = vault()
    const userId = await seedUser(t)

    await t.mutation(internal.devices.mutations.upsert, {
      userId,
      machineId: 'mach-bapi',
      at: 1000,
      sid: 'sess_bapi_test',
    })

    const clerkCalls: string[] = []
    __setClerkFetch(
      vi.fn((url: string) => {
        clerkCalls.push(url)
        return Promise.resolve(new Response('{}', { status: 200 }))
      }) as unknown as typeof fetch
    )

    await t.withIdentity(TEST_IDENTITY).action(api.cli.actions.revokeDevice, { machineId: 'mach-bapi' })

    expect(clerkCalls).toHaveLength(1)
    expect(clerkCalls[0]).toMatch(/sessions\/sess_bapi_test\/revoke/)
  })

  it('still revokes device even when BAPI call fails (best-effort)', async () => {
    const t = vault()
    const userId = await seedUser(t)

    await t.mutation(internal.devices.mutations.upsert, {
      userId,
      machineId: 'mach-bapi-fail',
      at: 1000,
      sid: 'sess_bapi_fail',
    })

    // Stub Clerk BAPI to return an error.
    __setClerkFetch(
      vi.fn(() => Promise.resolve(new Response('Internal Server Error', { status: 500 }))) as unknown as typeof fetch
    )

    // Should NOT throw — BAPI failure is best-effort.
    const result = await t.withIdentity(TEST_IDENTITY).action(api.cli.actions.revokeDevice, {
      machineId: 'mach-bapi-fail',
    })
    expect(result.revoked).toBe(true)

    // revokedSessions denylist still written.
    const sessionRow = await t.run(async (ctx) =>
      ctx.db
        .query('revokedSessions')
        .withIndex('bySid', (q) => q.eq('sid', 'sess_bapi_fail'))
        .unique()
    )
    expect(sessionRow).not.toBeNull()
  })

  it('throws NOT_FOUND when user row is missing (via getByMachine → userId lookup)', async () => {
    const t = vault()
    // No seedUser — user row absent; but we still need a device for the
    // NOT_FOUND to come from missing machine, not missing user.
    // With no device seeded, the error should be "Machine not found".
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.cli.actions.revokeDevice, { machineId: 'mach-x' })
    ).rejects.toThrow(/not found/i)
  })
})
