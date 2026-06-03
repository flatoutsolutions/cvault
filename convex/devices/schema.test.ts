/**
 * Devices table schema smoke-tests.
 *
 * Proves the table exists with the two named indexes and the correct fields
 * by inserting a (user, device) row and querying it back via both indexes.
 *
 * Approach: uses convex-test (same pattern as machineActivity/mutations.test.ts
 * and allowedEmails/queries.test.ts).
 */
import { describe, expect, it } from 'vitest'

import { seedUser, vault } from '../__tests__/helpers'

describe('devices table schema', () => {
  it('inserts a device row and retrieves it via byUserAndMachine index', async () => {
    const t = vault()
    const userId = await seedUser(t)

    const deviceId = await t.run(async (ctx) => {
      return await ctx.db.insert('devices', {
        userId,
        machineId: 'machine-uuid-abc123',
        label: 'office-laptop',
        createdAt: 1700000000000,
        lastSeenAt: 1700000001000,
      })
    })

    const row = await t.run(async (ctx) => {
      return await ctx.db
        .query('devices')
        .withIndex('byUserAndMachine', (q) => q.eq('userId', userId).eq('machineId', 'machine-uuid-abc123'))
        .unique()
    })

    expect(row).not.toBeNull()
    expect(row!._id).toBe(deviceId)
    expect(row!.machineId).toBe('machine-uuid-abc123')
    expect(row!.label).toBe('office-laptop')
    expect(row!.createdAt).toBe(1700000000000)
    expect(row!.lastSeenAt).toBe(1700000001000)
    expect(row!.revokedAt).toBeUndefined()
    expect(row!.grantRef).toBeUndefined()
  })

  it('retrieves a device row via byMachine index', async () => {
    const t = vault()
    const userId = await seedUser(t)

    await t.run(async (ctx) => {
      return await ctx.db.insert('devices', {
        userId,
        machineId: 'machine-uuid-xyz789',
        createdAt: 1700000002000,
        lastSeenAt: 1700000003000,
      })
    })

    const row = await t.run(async (ctx) => {
      return await ctx.db
        .query('devices')
        .withIndex('byMachine', (q) => q.eq('machineId', 'machine-uuid-xyz789'))
        .unique()
    })

    expect(row).not.toBeNull()
    expect(row!.userId).toBe(userId)
    expect(row!.machineId).toBe('machine-uuid-xyz789')
    // optional fields absent when not provided
    expect(row!.label).toBeUndefined()
  })

  it('stores optional fields grantRef and revokedAt when provided', async () => {
    const t = vault()
    const userId = await seedUser(t)

    await t.run(async (ctx) => {
      return await ctx.db.insert('devices', {
        userId,
        machineId: 'machine-uuid-revoked',
        createdAt: 1700000004000,
        lastSeenAt: 1700000005000,
        revokedAt: 1700000006000,
        grantRef: 'grant_clerk_abc',
      })
    })

    const row = await t.run(async (ctx) => {
      return await ctx.db
        .query('devices')
        .withIndex('byMachine', (q) => q.eq('machineId', 'machine-uuid-revoked'))
        .unique()
    })

    expect(row!.revokedAt).toBe(1700000006000)
    expect(row!.grantRef).toBe('grant_clerk_abc')
  })
})
