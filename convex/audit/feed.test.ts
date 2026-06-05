/**
 * Audit feed — `recentFeed` query.
 *
 * Merges `machineActivity` (CLI operations) and `refreshLog` (token refresh
 * attempts) into one chronological window, enriched server-side so the
 * dashboard can render human-readable rows without per-row client joins:
 *   - activity rows gain the actor user (name/avatar) + machine label
 *   - both kinds gain the affected subscription's email
 *
 * Shared vault — no userId scoping (see convex/utils/users.ts). Because the
 * window is fully materialised (bounded, not cursor-paginated), client-side
 * filtering over it is correct — no rows hide beyond an unloaded page.
 */
import { describe, expect, it } from 'vitest'

import { SECOND_IDENTITY, TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import type { Id } from '../_generated/dataModel'

type Vault = ReturnType<typeof vault>

async function seedSubRow(
  t: Vault,
  args: { userId: Id<'users'>; email: string; slot: number }
): Promise<Id<'subscriptions'>> {
  return await t.run(async (ctx) =>
    ctx.db.insert('subscriptions', {
      userId: args.userId,
      email: args.email,
      slot: args.slot,
      ciphertext: new ArrayBuffer(8),
      nonce: new ArrayBuffer(12),
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
      lastRefreshedAt: Date.now(),
    })
  )
}

async function seedDevice(t: Vault, args: { userId: Id<'users'>; machineId: string; label?: string }): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert('devices', {
      userId: args.userId,
      machineId: args.machineId,
      createdAt: 1000,
      lastSeenAt: 1000,
      ...(args.label !== undefined ? { label: args.label } : {}),
    })
  })
}

async function seedActivity(
  t: Vault,
  args: {
    userId: Id<'users'>
    machineId: string
    action: 'switch' | 'add' | 'pull' | 'remove' | 'refresh' | 'rename' | 'login' | 'export' | 'import' | 'rotate'
    subscriptionId?: Id<'subscriptions'>
    at: number
    ipHash?: string
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
      ...(args.ipHash !== undefined ? { ipHash: args.ipHash } : {}),
      ...(args.machineLabel !== undefined ? { machineLabel: args.machineLabel } : {}),
    })
  })
}

async function seedRefresh(
  t: Vault,
  args: {
    userId: Id<'users'>
    subscriptionId: Id<'subscriptions'>
    outcome: 'success' | 'failure' | 'reloginRequired'
    triggeredBy: 'cron' | 'manual' | 'onUse'
    at: number
    error?: string
  }
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert('refreshLog', {
      userId: args.userId,
      subscriptionId: args.subscriptionId,
      outcome: args.outcome,
      triggeredBy: args.triggeredBy,
      at: args.at,
      ...(args.error !== undefined ? { error: args.error } : {}),
    })
  })
}

const asAlice = (t: Vault) => t.withIdentity(TEST_IDENTITY)

describe('audit.feed.recentFeed', () => {
  it('throws when the caller is not authenticated', async () => {
    const t = vault()
    await expect(t.query(api.audit.feed.recentFeed, {})).rejects.toThrow(/authenticated/i)
  })

  it('returns an empty, uncapped feed when there is no activity', async () => {
    const t = vault()
    await seedUser(t)
    const res = await asAlice(t).query(api.audit.feed.recentFeed, {})
    expect(res.events).toEqual([])
    expect(res.capped).toBe(false)
  })

  it('enriches an activity event with actor, machine label, and sub email', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'team@acme.com', slot: 1 })
    await seedDevice(t, { userId: aliceId, machineId: 'mac-1', label: "Alice's MacBook" })
    await seedActivity(t, {
      userId: aliceId,
      machineId: 'mac-1',
      action: 'switch',
      subscriptionId: subId,
      at: 5000,
      ipHash: 'a1b2c3d4',
    })

    const res = await asAlice(t).query(api.audit.feed.recentFeed, {})
    expect(res.events).toHaveLength(1)
    const ev = res.events[0]
    if (ev?.kind !== 'activity') throw new Error('expected an activity event')
    expect(ev.action).toBe('switch')
    expect(ev.subEmail).toBe('team@acme.com')
    expect(ev.machineLabel).toBe("Alice's MacBook")
    expect(ev.actor?.name).toBe('Alice Tester')
    expect(ev.ipHash).toBe('a1b2c3d4')
  })

  it('enriches a refresh event with outcome, trigger, and sub email (no actor)', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'team@acme.com', slot: 1 })
    await seedRefresh(t, {
      userId: aliceId,
      subscriptionId: subId,
      outcome: 'failure',
      triggeredBy: 'onUse',
      at: 5000,
      error: 'Anthropic 500',
    })

    const res = await asAlice(t).query(api.audit.feed.recentFeed, {})
    expect(res.events).toHaveLength(1)
    const ev = res.events[0]
    if (ev?.kind !== 'refresh') throw new Error('expected a refresh event')
    expect(ev.outcome).toBe('failure')
    expect(ev.triggeredBy).toBe('onUse')
    expect(ev.subEmail).toBe('team@acme.com')
    expect(ev.error).toBe('Anthropic 500')
  })

  it('merges activity and refresh events, newest first', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'team@acme.com', slot: 1 })
    await seedRefresh(t, {
      userId: aliceId,
      subscriptionId: subId,
      outcome: 'success',
      triggeredBy: 'manual',
      at: 1000,
    })
    await seedActivity(t, { userId: aliceId, machineId: 'mac-1', action: 'add', subscriptionId: subId, at: 9000 })
    await seedRefresh(t, {
      userId: aliceId,
      subscriptionId: subId,
      outcome: 'success',
      triggeredBy: 'manual',
      at: 5000,
    })

    const res = await asAlice(t).query(api.audit.feed.recentFeed, {})
    expect(res.events.map((e) => e.at)).toEqual([9000, 5000, 1000])
    expect(res.events[0]?.kind).toBe('activity')
  })

  it('prefers the device label but falls back to the row machineLabel when no device exists', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'team@acme.com', slot: 1 })
    // Device label wins.
    await seedDevice(t, { userId: aliceId, machineId: 'mac-1', label: 'Device Label' })
    await seedActivity(t, {
      userId: aliceId,
      machineId: 'mac-1',
      action: 'switch',
      subscriptionId: subId,
      at: 8000,
      machineLabel: 'Row Label',
    })
    // No device → fall back to the row's machineLabel.
    await seedActivity(t, {
      userId: aliceId,
      machineId: 'mac-legacy',
      action: 'switch',
      subscriptionId: subId,
      at: 7000,
      machineLabel: 'Legacy Row Label',
    })

    const res = await asAlice(t).query(api.audit.feed.recentFeed, {})
    const byMachine = new Map(
      res.events.flatMap((e) => (e.kind === 'activity' ? [[e.machineId, e.machineLabel] as const] : []))
    )
    expect(byMachine.get('mac-1')).toBe('Device Label')
    expect(byMachine.get('mac-legacy')).toBe('Legacy Row Label')
  })

  it('omits the actor when no matching user row exists', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    const subId = await seedSubRow(t, { userId: aliceId, email: 'team@acme.com', slot: 1 })
    // Activity attributed to a user id with no row (simulate orphan by deleting).
    const ghostId = await seedUser(t, SECOND_IDENTITY)
    await t.run(async (ctx) => {
      await ctx.db.delete('users', ghostId)
    })
    await seedActivity(t, { userId: ghostId, machineId: 'mac-1', action: 'switch', subscriptionId: subId, at: 5000 })

    const res = await asAlice(t).query(api.audit.feed.recentFeed, {})
    const ev = res.events[0]
    if (ev?.kind !== 'activity') throw new Error('expected an activity event')
    expect(ev.actor).toBeUndefined()
  })

  it('leaves subEmail undefined for an activity with no subscriptionId (bulk pull)', async () => {
    const t = vault()
    const aliceId = await seedUser(t)
    await seedActivity(t, { userId: aliceId, machineId: 'mac-1', action: 'pull', at: 5000 })

    const res = await asAlice(t).query(api.audit.feed.recentFeed, {})
    const ev = res.events[0]
    if (ev?.kind !== 'activity') throw new Error('expected an activity event')
    expect(ev.subEmail).toBeUndefined()
  })
})
