/**
 * CVLT-3: Tests for the rewritten CLI actions.
 *
 * - `recordLogin({machineId, machineLabel?, grantRef?})` — upserts a device
 *   row and writes a `login` machineActivity row.
 * - `revokeDevice({machineId})` — looks up the device, skips
 *   revokeOAuthGrant when grantRef is undefined, marks the device revoked,
 *   and writes a `remove` machineActivity row.
 *
 * `startLink` and `revokeSession` have been removed in this task.
 * Their callers (frontend, CLI) are updated in Tasks 14–18.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'

afterEach(() => {
  // No Clerk fetch stubs needed — the new actions don't call Clerk BAPI directly.
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

  it('marks the device revoked and writes a remove activity row (grantRef=undefined path — revokeOAuthGrant NOT called)', async () => {
    const t = vault()
    const userId = await seedUser(t)

    // Register the device first (no grantRef — Phase 0 deferred).
    await t.mutation(internal.devices.mutations.upsert, {
      userId,
      machineId: 'mach-1',
      label: 'work-laptop',
      at: 1000,
    })

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

    // machineActivity should have a `remove` row.
    const activity = await t.run(async (ctx) => ctx.db.query('machineActivity').collect())
    expect(activity).toHaveLength(1)
    expect(activity[0]?.action).toBe('remove')
    expect(activity[0]?.machineId).toBe('mach-1')
    expect(activity[0]?.userId).toStrictEqual(userId)
  })

  it('throws NOT_FOUND when user row is missing', async () => {
    const t = vault()
    // No seedUser — user row absent.
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.cli.actions.revokeDevice, { machineId: 'mach-x' })
    ).rejects.toThrow(/not found/i)
  })
})
