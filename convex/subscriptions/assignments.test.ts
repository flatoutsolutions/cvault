/**
 * CVLT-1 — `listAssignments` query.
 *
 * Derives "who recently used which subscription" from existing data: a
 * machine's CURRENT subscription is the most-recent `machineActivity` row for
 * that machine whose action activates a sub (`add`, or `pull` with a
 * `subscriptionId` — what `cvault switch` records) and carries a
 * `subscriptionId`. Machines are attributed to a person via their `devices`
 * row (owner); revoked devices and users on the `revokedUsers` denylist are
 * excluded. The query returns one entry per live subscription with the
 * distinct people on it.
 *
 * Shared vault — no userId scoping (see convex/utils/users.ts).
 */
import { describe, expect, it } from 'vitest'

import { SECOND_IDENTITY, TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import type { Id } from '../_generated/dataModel'

type Vault = ReturnType<typeof vault>

async function seedSubRow(
  t: Vault,
  args: { userId: Id<'users'>; email: string; slot: number; removed?: boolean }
): Promise<Id<'subscriptions'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('subscriptions', {
      userId: args.userId,
      email: args.email,
      slot: args.slot,
      ciphertext: new ArrayBuffer(8),
      nonce: new ArrayBuffer(12),
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
      lastRefreshedAt: Date.now(),
      ...(args.removed === true ? { removedAt: Date.now() } : {}),
    })
  })
}

async function seedDevice(
  t: Vault,
  args: { userId: Id<'users'>; machineId: string; label?: string; revoked?: boolean }
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert('devices', {
      userId: args.userId,
      machineId: args.machineId,
      createdAt: 1000,
      lastSeenAt: 1000,
      ...(args.label !== undefined ? { label: args.label } : {}),
      ...(args.revoked === true ? { revokedAt: Date.now() } : {}),
    })
  })
}

async function seedActivity(
  t: Vault,
  args: {
    userId: Id<'users'>
    machineId: string
    action: 'switch' | 'add' | 'pull' | 'remove' | 'refresh' | 'rename'
    subscriptionId?: Id<'subscriptions'>
    at: number
    machineLabel?: string
  }
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert('machineActivity', {
      userId: args.userId,
      machineId: args.machineId,
      action: args.action,
      at: args.at,
      ...(args.subscriptionId !== undefined ? { subscriptionId: args.subscriptionId } : {}),
      ...(args.machineLabel !== undefined ? { machineLabel: args.machineLabel } : {}),
    })
  })
}

const asAlice = (t: Vault) => t.withIdentity(TEST_IDENTITY)

describe('subscriptions.queries.listAssignments', () => {
  it('throws when the caller is not authenticated', async () => {
    const t = vault()
    await expect(t.query(api.subscriptions.assignments.listAssignments, {})).rejects.toThrow(/authenticated/i)
  })

  it('returns one entry per live subscription, empty when nobody is on it', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'a@example.com', slot: 1 })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    expect(result).toHaveLength(1)
    expect(result[0]?.subscriptionId).toStrictEqual(subId)
    expect(result[0]?.users).toEqual([])
  })

  it('groups a machine under the sub it most recently switched to, with the owner', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'a@example.com', slot: 1 })
    await seedDevice(t, { userId: aliceId, machineId: 'mac-1', label: "Alice's MacBook" })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-1', action: 'pull', subscriptionId: subId, at: 5000 })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    const entry = result.find((r) => r.subscriptionId === subId)
    expect(entry?.users).toHaveLength(1)
    expect(entry?.users[0]?.userId).toStrictEqual(aliceId)
    expect(entry?.users[0]?.name).toBe('Alice Tester')
    expect(entry?.users[0]?.email).toBe('alice@flatout.solutions')
    expect(entry?.users[0]?.machines).toEqual([{ machineId: 'mac-1', label: "Alice's MacBook", lastUsedAt: 5000 }])
    expect(entry?.users[0]?.lastUsedAt).toBe(5000)
  })

  it('passes through the user imageUrl when present', async () => {
    const t = vault()
    const aliceId = await t.run(async (ctx) =>
      ctx.db.insert('users', {
        externalId: TEST_IDENTITY.subject,
        name: 'Alice Tester',
        primaryEmail: 'alice@flatout.solutions',
        otherEmails: [],
        imageUrl: 'https://img.example/alice.png',
      })
    )
    const subId = await seedSubRow(t, { userId: aliceId, email: 'a@example.com', slot: 1 })
    await seedDevice(t, { userId: aliceId, machineId: 'mac-1' })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-1', action: 'pull', subscriptionId: subId, at: 5000 })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    expect(result.find((r) => r.subscriptionId === subId)?.users[0]?.imageUrl).toBe('https://img.example/alice.png')
  })

  it('ignores whole-bundle pulls and other actions that carry no subscriptionId', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'a@example.com', slot: 1 })
    await seedDevice(t, { userId: aliceId, machineId: 'mac-1' })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-1', action: 'pull', at: 5000 })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    expect(result.find((r) => r.subscriptionId === subId)?.users).toEqual([])
  })

  it('does not assign a machine off a non-activation action (refresh) alone', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'a@example.com', slot: 1 })
    await seedDevice(t, { userId: aliceId, machineId: 'mac-1' })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-1', action: 'refresh', subscriptionId: subId, at: 5000 })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    expect(result.find((r) => r.subscriptionId === subId)?.users).toEqual([])
  })

  it('uses the most recent activation when a machine switched subs (B wins over A)', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subA = await seedSubRow(t, { userId: aliceId, email: 'a@example.com', slot: 1 })
    const subB = await seedSubRow(t, { userId: aliceId, email: 'b@example.com', slot: 2 })
    await seedDevice(t, { userId: aliceId, machineId: 'mac-1' })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-1', action: 'pull', subscriptionId: subA, at: 1000 })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-1', action: 'pull', subscriptionId: subB, at: 9000 })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    expect(result.find((r) => r.subscriptionId === subA)?.users).toEqual([])
    expect(result.find((r) => r.subscriptionId === subB)?.users).toHaveLength(1)
  })

  it("does not activate off a legacy 'switch' row (no current writer emits one)", async () => {
    // `cvault switch` records a `pull`; the `switch` literal is retained in the
    // schema only for historical rows and is intentionally not an activation.
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'a@example.com', slot: 1 })
    await seedDevice(t, { userId: aliceId, machineId: 'mac-1' })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-1', action: 'switch', subscriptionId: subId, at: 5000 })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    expect(result.find((r) => r.subscriptionId === subId)?.users).toEqual([])
  })

  it('excludes machines whose device has been revoked', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'a@example.com', slot: 1 })
    await seedDevice(t, { userId: aliceId, machineId: 'mac-1', revoked: true })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-1', action: 'pull', subscriptionId: subId, at: 5000 })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    expect(result.find((r) => r.subscriptionId === subId)?.users).toEqual([])
  })

  it('excludes a user on the revokedUsers denylist (user-level ban)', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'shared@example.com', slot: 1 })
    await seedDevice(t, { userId: aliceId, machineId: 'mac-a' })
    await seedDevice(t, { userId: bobId, machineId: 'mac-b' })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-a', action: 'pull', subscriptionId: subId, at: 4000 })
    await seedActivity(t, { userId: bobId, machineId: 'mac-b', action: 'add', subscriptionId: subId, at: 6000 })
    // Ban Bob at the user level — his device isn't revoked, but he's locked out.
    await t.run(async (ctx) => {
      await ctx.db.insert('revokedUsers', { externalId: SECOND_IDENTITY.subject, at: Date.now() })
    })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    const entry = result.find((r) => r.subscriptionId === subId)
    expect(entry?.users.map((u) => u.userId)).toEqual([aliceId])
  })

  it("dedupes a person's machines into one entry and reports the max lastUsedAt", async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'a@example.com', slot: 1 })
    await seedDevice(t, { userId: aliceId, machineId: 'mac-1', label: 'Laptop' })
    await seedDevice(t, { userId: aliceId, machineId: 'mac-2', label: 'Desktop' })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-1', action: 'pull', subscriptionId: subId, at: 3000 })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-2', action: 'pull', subscriptionId: subId, at: 7000 })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    const entry = result.find((r) => r.subscriptionId === subId)
    expect(entry?.users).toHaveLength(1)
    expect(entry?.users[0]?.machines.map((m) => m.machineId).sort()).toEqual(['mac-1', 'mac-2'])
    expect(entry?.users[0]?.lastUsedAt).toBe(7000)
  })

  it('attributes via the activity actor when no device row exists (legacy machine)', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'a@example.com', slot: 1 })
    // No device row for mac-legacy.
    await seedActivity(t, {
      userId: aliceId,
      machineId: 'mac-legacy',
      action: 'pull',
      subscriptionId: subId,
      at: 5000,
    })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    const entry = result.find((r) => r.subscriptionId === subId)
    expect(entry?.users).toHaveLength(1)
    expect(entry?.users[0]?.userId).toStrictEqual(aliceId)
    expect(entry?.users[0]?.machines[0]?.machineId).toBe('mac-legacy')
  })

  it('groups two different people onto the same shared subscription', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'shared@example.com', slot: 1 })
    await seedDevice(t, { userId: aliceId, machineId: 'mac-a' })
    await seedDevice(t, { userId: bobId, machineId: 'mac-b' })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-a', action: 'pull', subscriptionId: subId, at: 4000 })
    await seedActivity(t, { userId: bobId, machineId: 'mac-b', action: 'add', subscriptionId: subId, at: 6000 })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    const entry = result.find((r) => r.subscriptionId === subId)
    expect(entry?.users.map((u) => u.userId).sort()).toEqual([aliceId, bobId].sort())
  })

  it('excludes soft-removed subscriptions from the result', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const liveId = await seedSubRow(t, { userId: aliceId, email: 'live@example.com', slot: 1 })
    const goneId = await seedSubRow(t, { userId: aliceId, email: 'gone@example.com', slot: 2, removed: true })

    const result = await asAlice(t).query(api.subscriptions.assignments.listAssignments, {})

    expect(result.find((r) => r.subscriptionId === liveId)).toBeDefined()
    expect(result.find((r) => r.subscriptionId === goneId)).toBeUndefined()
  })
})
