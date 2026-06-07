/**
 * CVLT-1 — "who is using which subscription".
 *
 * Derives the current user↔subscription mapping from data the vault already
 * records, so no schema change is needed:
 *
 *   - A machine's CURRENT subscription is the most-recent `machineActivity`
 *     row for that machine whose action ACTIVATES a sub (`switch` / `add` /
 *     `pull`) and carries a `subscriptionId`. Non-activation rows (`refresh`,
 *     `rename`, `remove`, …) and whole-bundle pulls (no `subscriptionId`)
 *     don't change which sub a machine is on, so they're skipped.
 *   - A machine is attributed to a person via its `devices` row (owner).
 *     Revoked devices are excluded (that machine is signed out). Legacy
 *     machines with no device row fall back to the activity row's actor.
 *
 * Shared vault — no `userId` scoping (see convex/utils/users.ts:3-7), matching
 * every other dashboard read. The query returns one entry per live
 * subscription with the distinct people currently on it, so the dashboard can
 * render an avatar stack per card.
 */
import { v } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { authenticatedQuery } from '../utils/auth'

/**
 * Actions that mean "this machine is now on this sub". These are the only
 * activation actions any current code path writes: `cvault add` (records
 * `add`) and `cvault switch` / `cvault pull <sub>` (both record `pull` with a
 * subscriptionId via pullForSwitch). A `pull` WITHOUT a subscriptionId is a
 * whole-bundle sync and is filtered out by the subscriptionId check below, not
 * here.
 *
 * NB: the `machineActivity` schema still permits a legacy `switch` action
 * literal, but no mutation has emitted it since `cvault switch` was changed to
 * record `pull`, so it is intentionally NOT in this set.
 */
const ACTIVATION_ACTIONS: ReadonlySet<string> = new Set(['add', 'pull'])

/**
 * Cap on the number of recent activity rows scanned to resolve current
 * assignments. Matches `machineActivity.queries.distinctSessionsForUser` — the
 * dashboard summarises machines, not raw events, so the most-recent window is
 * sufficient for the deployment size.
 */
const RECENT_ACTIVITY_LIMIT = 1000

const machineValidator = v.object({
  machineId: v.string(),
  label: v.optional(v.string()),
  lastUsedAt: v.number(),
})

const userOnSubscriptionValidator = v.object({
  userId: v.id('users'),
  name: v.string(),
  email: v.string(),
  imageUrl: v.optional(v.string()),
  machines: v.array(machineValidator),
  /** Max `lastUsedAt` across this person's machines on the sub. */
  lastUsedAt: v.number(),
})

const subscriptionAssignmentValidator = v.object({
  subscriptionId: v.id('subscriptions'),
  users: v.array(userOnSubscriptionValidator),
})

type MachineEntry = { machineId: string; label?: string; lastUsedAt: number }
type UserAggregate = {
  userId: Id<'users'>
  name: string
  email: string
  imageUrl?: string
  machines: MachineEntry[]
  lastUsedAt: number
}

/**
 * The current activation for a machine: which sub it's on, when, and the
 * actor of that activation (used to attribute legacy machines with no device
 * row).
 */
type CurrentAssignment = { subscriptionId: Id<'subscriptions'>; at: number; actorUserId: Id<'users'> }

export const listAssignments = authenticatedQuery({
  args: {},
  returns: v.array(subscriptionAssignmentValidator),
  handler: async (ctx) => {
    const liveSubs = (await ctx.db.query('subscriptions').collect())
      .filter((s) => s.removedAt === undefined)
      .sort((a, b) => a._creationTime - b._creationTime)

    // Resolve each machine's current activation by walking recent activity
    // newest-first; the first activation row per machine wins.
    const recent = await ctx.db.query('machineActivity').withIndex('byAt').order('desc').take(RECENT_ACTIVITY_LIMIT)
    const currentByMachine = new Map<string, CurrentAssignment>()
    for (const row of recent) {
      if (!row.machineId) continue
      if (currentByMachine.has(row.machineId)) continue
      if (!ACTIVATION_ACTIONS.has(row.action)) continue
      if (row.subscriptionId === undefined) continue
      currentByMachine.set(row.machineId, {
        subscriptionId: row.subscriptionId,
        at: row.at,
        actorUserId: row.userId,
      })
    }

    // Full-table read. Fine at shared-vault scale (tens of devices). If the
    // device registry grows large, resolve only the machineIds in
    // `currentByMachine` via the `byMachine` index (devices/schema.ts) instead
    // of collecting every row.
    const deviceByMachine = new Map<string, Doc<'devices'>>()
    for (const d of await ctx.db.query('devices').collect()) {
      deviceByMachine.set(d.machineId, d)
    }

    // Full-table read, same tradeoff as `devices` above. At scale, look up only
    // the distinct owner ids resolved below via `ctx.db.get` rather than
    // collecting the whole `users` table.
    const userById = new Map<Id<'users'>, Doc<'users'>>()
    for (const u of await ctx.db.query('users').collect()) {
      userById.set(u._id, u)
    }

    // User-level bans (the `revokedUsers` denylist). A banned user is locked
    // out of the whole vault everywhere else via `denylist.queries.check`'s
    // `userRevoked` (see convex/utils/auth.ts). A Convex query can't
    // `runQuery`, so we read the same denylist table directly here — keyed by
    // Clerk `externalId`, matching that check's semantics exactly.
    const bannedExternalIds = new Set<string>()
    for (const r of await ctx.db.query('revokedUsers').collect()) {
      bannedExternalIds.add(r.externalId)
    }

    // subscriptionId -> (ownerUserId -> aggregate)
    const bySub = new Map<Id<'subscriptions'>, Map<Id<'users'>, UserAggregate>>()
    for (const [machineId, current] of currentByMachine) {
      const device = deviceByMachine.get(machineId)
      // A revoked machine is signed out — it's no longer "using" anything.
      if (device !== undefined && device.revokedAt !== undefined) continue

      const ownerUserId = device?.userId ?? current.actorUserId
      const user = userById.get(ownerUserId)
      if (user === undefined) continue // orphan attribution — defensive.
      // A user-level ban signs the person out of the entire vault, so they're
      // no longer "using" anything — exclude them just like a revoked device.
      if (bannedExternalIds.has(user.externalId)) continue

      let userMap = bySub.get(current.subscriptionId)
      if (userMap === undefined) {
        userMap = new Map()
        bySub.set(current.subscriptionId, userMap)
      }
      let agg = userMap.get(ownerUserId)
      if (agg === undefined) {
        agg = {
          userId: ownerUserId,
          name: user.name,
          email: user.primaryEmail,
          machines: [],
          lastUsedAt: 0,
          ...(user.imageUrl !== undefined ? { imageUrl: user.imageUrl } : {}),
        }
        userMap.set(ownerUserId, agg)
      }
      agg.machines.push({
        machineId,
        lastUsedAt: current.at,
        ...(device?.label !== undefined ? { label: device.label } : {}),
      })
      if (current.at > agg.lastUsedAt) agg.lastUsedAt = current.at
    }

    return liveSubs.map((sub) => {
      const userMap = bySub.get(sub._id)
      const users =
        userMap === undefined
          ? []
          : Array.from(userMap.values())
              .map((u) => ({
                ...u,
                machines: [...u.machines].sort((a, b) => b.lastUsedAt - a.lastUsedAt),
              }))
              .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      return { subscriptionId: sub._id, users }
    })
  },
})
