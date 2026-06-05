/**
 * Audit feed — the human-readable activity stream behind `/dashboard/audit`.
 *
 * `recentFeed` merges two append-only sources into one chronological window:
 *   - `machineActivity` — CLI operations (switch / add / login / export / …)
 *   - `refreshLog`      — OAuth token-refresh attempts (success / failure / …)
 *
 * and enriches each event SERVER-SIDE so the page renders a plain-language row
 * without per-row client joins:
 *   - activity → actor (the user who ran it) + machine label + sub email
 *   - refresh  → outcome + trigger + sub email (no human actor — it's the
 *                vault's automatic refresh, surfaced as "System" in the UI)
 *
 * WINDOW (not cursor pagination). The feed returns the most-recent
 * `WINDOW_LIMIT` events as one fully-materialised array. The previous design
 * paginated each source independently and merged client-side, which made
 * client-side filters LEAKY — a filtered row could sit on an unloaded page and
 * silently never appear. A bounded window makes filtering correct: every row
 * the filter could match is already in hand. `capped` tells the UI when older
 * events exist beyond the window so it can say so honestly.
 *
 * Shared vault — no `userId` scoping (see convex/utils/users.ts:3-7), matching
 * the rest of the dashboard reads.
 */
import { v } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { authenticatedQuery } from '../utils/auth'
import { UNKNOWN_SESSION_SENTINEL } from '../utils/identity'

/**
 * Most-recent events returned in one shot. Taken from EACH source before the
 * merge, so the merged top-`WINDOW_LIMIT` is the true most-recent window. For
 * an internal vault this is a generous bound; `capped` flags when it's hit.
 */
const WINDOW_LIMIT = 500

const actionValidator = v.union(
  v.literal('switch'),
  v.literal('add'),
  v.literal('pull'),
  v.literal('remove'),
  v.literal('refresh'),
  v.literal('rename'),
  v.literal('login'),
  v.literal('export'),
  v.literal('import'),
  v.literal('rotate')
)

const actorValidator = v.object({
  userId: v.id('users'),
  name: v.string(),
  imageUrl: v.optional(v.string()),
})

const activityEventValidator = v.object({
  kind: v.literal('activity'),
  id: v.string(),
  at: v.number(),
  action: actionValidator,
  subEmail: v.optional(v.string()),
  machineId: v.string(),
  machineLabel: v.optional(v.string()),
  actor: v.optional(actorValidator),
  ipHash: v.optional(v.string()),
})

const refreshEventValidator = v.object({
  kind: v.literal('refresh'),
  id: v.string(),
  at: v.number(),
  subEmail: v.optional(v.string()),
  outcome: v.union(v.literal('success'), v.literal('failure'), v.literal('reloginRequired')),
  triggeredBy: v.union(v.literal('cron'), v.literal('manual'), v.literal('onUse')),
  error: v.optional(v.string()),
})

type Actor = { userId: Id<'users'>; name: string; imageUrl?: string }

export const recentFeed = authenticatedQuery({
  args: {},
  returns: v.object({
    events: v.array(v.union(activityEventValidator, refreshEventValidator)),
    /** True when older events exist beyond the returned window. */
    capped: v.boolean(),
  }),
  handler: async (ctx) => {
    const activityRows = await ctx.db.query('machineActivity').withIndex('byAt').order('desc').take(WINDOW_LIMIT)
    const refreshRows = await ctx.db.query('refreshLog').withIndex('byAt').order('desc').take(WINDOW_LIMIT)

    // Enrichment lookups. Each table is small for this deployment; collect once
    // and resolve in-memory rather than per-row queries.
    const subEmailById = new Map<Id<'subscriptions'>, string>()
    for (const s of await ctx.db.query('subscriptions').collect()) subEmailById.set(s._id, s.email)

    const deviceLabelByMachine = new Map<string, string>()
    for (const d of await ctx.db.query('devices').collect()) {
      if (d.label !== undefined) deviceLabelByMachine.set(d.machineId, d.label)
    }

    const actorById = new Map<Id<'users'>, Actor>()
    for (const u of await ctx.db.query('users').collect()) {
      actorById.set(u._id, {
        userId: u._id,
        name: u.name,
        ...(u.imageUrl !== undefined ? { imageUrl: u.imageUrl } : {}),
      })
    }

    const activityEvents = activityRows.map((row) =>
      toActivityEvent(row, subEmailById, deviceLabelByMachine, actorById)
    )
    const refreshEvents = refreshRows.map((row) => toRefreshEvent(row, subEmailById))

    const merged = [...activityEvents, ...refreshEvents].sort((a, b) => b.at - a.at)
    const events = merged.slice(0, WINDOW_LIMIT)

    // Older rows exist beyond the window if either source filled its own cap,
    // or the merge itself overflowed the window.
    const capped =
      activityRows.length === WINDOW_LIMIT || refreshRows.length === WINDOW_LIMIT || merged.length > WINDOW_LIMIT

    return { events, capped }
  },
})

type ActivityEvent = {
  kind: 'activity'
  id: string
  at: number
  action: Doc<'machineActivity'>['action']
  subEmail?: string
  machineId: string
  machineLabel?: string
  actor?: Actor
  ipHash?: string
}

function toActivityEvent(
  row: Doc<'machineActivity'>,
  subEmailById: Map<Id<'subscriptions'>, string>,
  deviceLabelByMachine: Map<string, string>,
  actorById: Map<Id<'users'>, Actor>
): ActivityEvent {
  // CVLT-3 migration coalescing: legacy rows carry `clerkSessionId` with no
  // `machineId`. Surface a stable, non-empty key so the validator holds.
  const machineId = row.machineId ?? row.clerkSessionId ?? UNKNOWN_SESSION_SENTINEL
  // Device label is the canonical human name; fall back to the label stamped
  // on the activity row (legacy machines with no device registry row).
  const machineLabel = deviceLabelByMachine.get(machineId) ?? row.machineLabel
  const actor = actorById.get(row.userId)
  const subEmail = row.subscriptionId !== undefined ? subEmailById.get(row.subscriptionId) : undefined

  return {
    kind: 'activity',
    id: row._id,
    at: row.at,
    action: row.action,
    machineId,
    ...(machineLabel !== undefined ? { machineLabel } : {}),
    ...(actor !== undefined ? { actor } : {}),
    ...(subEmail !== undefined ? { subEmail } : {}),
    ...(row.ipHash !== undefined ? { ipHash: row.ipHash } : {}),
  }
}

type RefreshEvent = {
  kind: 'refresh'
  id: string
  at: number
  subEmail?: string
  outcome: Doc<'refreshLog'>['outcome']
  triggeredBy: Doc<'refreshLog'>['triggeredBy']
  error?: string
}

function toRefreshEvent(row: Doc<'refreshLog'>, subEmailById: Map<Id<'subscriptions'>, string>): RefreshEvent {
  const subEmail = subEmailById.get(row.subscriptionId)
  return {
    kind: 'refresh',
    id: row._id,
    at: row.at,
    outcome: row.outcome,
    triggeredBy: row.triggeredBy,
    ...(subEmail !== undefined ? { subEmail } : {}),
    ...(row.error !== undefined ? { error: row.error } : {}),
  }
}
