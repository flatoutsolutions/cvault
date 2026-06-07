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
 * SERVER-SIDE FILTERING. The page's sub / machine / status / routine filters
 * are passed as query args and applied here, while scanning each source from
 * newest backwards. This searches the WHOLE history for matches — not just a
 * recent slice — so a matching event can never hide behind an unloaded page or
 * outside a materialised window (the bug the previous client-filtered designs
 * both had). We stop a source once it has yielded `WINDOW_LIMIT` matches or we
 * have examined `SCAN_LIMIT` rows; `capped` then tells the UI that older
 * matches may exist beyond what was returned so it can say so honestly.
 *
 * The health summary strip does NOT read this filtered feed — a filter must not
 * change "is the vault healthy?". It reads {@link feedSummary}, which is
 * computed over unfiltered, authoritative state.
 *
 * Shared vault — no `userId` scoping (see convex/utils/users.ts:3-7), matching
 * the rest of the dashboard reads.
 */
import { v } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { authenticatedQuery } from '../utils/auth'
import { coalesceMachineId } from '../utils/identity'

/**
 * Max matching events returned in one shot, taken from EACH source before the
 * merge, so the merged top-`WINDOW_LIMIT` is the true most-recent matching
 * window. For an internal vault this is a generous bound; `capped` flags it.
 */
const WINDOW_LIMIT = 500

/**
 * Safety bound on how many rows a single filtered scan examines per source
 * before giving up and flagging `capped`. Keeps query cost predictable when a
 * restrictive filter (e.g. a rare failure) would otherwise walk the entire
 * append-only history. Generous enough that an internal vault scans everything
 * in practice.
 */
const SCAN_LIMIT = 5000

/** Distinct machines counted as "active" for the summary strip — over the most
 * recent activity, not all history. */
const SUMMARY_ACTIVITY_WINDOW = 500

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

const statusValidator = v.union(v.literal('ok'), v.literal('failed'), v.literal('attention'))

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
type FeedEvent = ActivityEvent | RefreshEvent
type EventStatus = 'ok' | 'failed' | 'attention'

type Filters = {
  sub?: string
  machine?: string
  status?: EventStatus
  /** When false, routine events (successful auto-refreshes, bulk pulls) are
   * dropped — the page's default. Omitted on the wire means "include". */
  includeRoutine: boolean
}

/**
 * Status tier of an event. Mirror of the frontend's `eventStatus`
 * (frontend/src/components/dashboard/auditEvent.ts) — keep the two in sync so
 * server-side filtering matches what the badge renders.
 */
function statusOf(e: FeedEvent): EventStatus {
  if (e.kind === 'activity') return 'ok'
  if (e.outcome === 'success') return 'ok'
  if (e.outcome === 'reloginRequired') return 'attention'
  return 'failed'
}

/**
 * Routine = high-volume, low-signal events: successful automatic refreshes and
 * whole-bundle credential syncs (`pull`). Hidden by default so meaningful
 * events stand out; the page's "Show routine events" toggle flips
 * `includeRoutine`.
 */
function isRoutineEvent(e: FeedEvent): boolean {
  if (e.kind === 'refresh') return e.outcome === 'success'
  return e.action === 'pull'
}

function matchesFilters(e: FeedEvent, f: Filters): boolean {
  if (!f.includeRoutine && isRoutineEvent(e)) return false
  if (f.sub !== undefined && e.subEmail !== f.sub) return false
  // Machine is an activity-only dimension; a machine filter excludes refreshes.
  if (f.machine !== undefined && (e.kind !== 'activity' || e.machineId !== f.machine)) return false
  if (f.status !== undefined && statusOf(e) !== f.status) return false
  return true
}

/**
 * Scan one source newest-first, enriching and filtering each row, until it has
 * yielded `WINDOW_LIMIT` matches or examined `SCAN_LIMIT` rows. `more` is true
 * when the scan stopped early — i.e. older matching rows may exist unsearched.
 */
async function collectFiltered<TDoc>(
  rows: AsyncIterable<TDoc>,
  toEvent: (row: TDoc) => FeedEvent,
  filters: Filters
): Promise<{ events: FeedEvent[]; more: boolean }> {
  const events: FeedEvent[] = []
  let scanned = 0
  for await (const row of rows) {
    scanned += 1
    const e = toEvent(row)
    if (matchesFilters(e, filters)) {
      events.push(e)
      if (events.length >= WINDOW_LIMIT) return { events, more: true }
    }
    if (scanned >= SCAN_LIMIT) return { events, more: true }
  }
  return { events, more: false }
}

export const recentFeed = authenticatedQuery({
  args: {
    /** Filter to one subscription email. */
    sub: v.optional(v.string()),
    /** Filter to one machine id (activity-only dimension). */
    machine: v.optional(v.string()),
    /** Filter to one status tier. */
    status: v.optional(statusValidator),
    /** Include routine events (successful refreshes, bulk pulls). Omitted means
     * include — the page sends `false` to hide them by default. */
    includeRoutine: v.optional(v.boolean()),
  },
  returns: v.object({
    events: v.array(v.union(activityEventValidator, refreshEventValidator)),
    /** True when older matching events may exist beyond what was returned. */
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const filters: Filters = {
      ...(args.sub !== undefined ? { sub: args.sub } : {}),
      ...(args.machine !== undefined ? { machine: args.machine } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      includeRoutine: args.includeRoutine ?? true,
    }

    // Enrichment lookups. Each table is small for this deployment; collect once
    // and resolve in-memory rather than per-row queries.
    const [subscriptions, devices, users] = await Promise.all([
      ctx.db.query('subscriptions').collect(),
      ctx.db.query('devices').collect(),
      ctx.db.query('users').collect(),
    ])

    const subEmailById = new Map<Id<'subscriptions'>, string>()
    for (const s of subscriptions) subEmailById.set(s._id, s.email)

    const deviceLabelByMachine = new Map<string, string>()
    for (const d of devices) {
      if (d.label !== undefined) deviceLabelByMachine.set(d.machineId, d.label)
    }

    const actorById = new Map<Id<'users'>, Actor>()
    for (const u of users) {
      actorById.set(u._id, {
        userId: u._id,
        name: u.name,
        ...(u.imageUrl !== undefined ? { imageUrl: u.imageUrl } : {}),
      })
    }

    // Scan both sources concurrently, newest-first, applying the filters.
    const [activity, refresh] = await Promise.all([
      collectFiltered(
        ctx.db.query('machineActivity').withIndex('byAt').order('desc'),
        (row) => toActivityEvent(row, subEmailById, deviceLabelByMachine, actorById),
        filters
      ),
      collectFiltered(
        ctx.db.query('refreshLog').withIndex('byAt').order('desc'),
        (row) => toRefreshEvent(row, subEmailById),
        filters
      ),
    ])

    const merged = [...activity.events, ...refresh.events].sort((a, b) => b.at - a.at)
    const events = merged.slice(0, WINDOW_LIMIT)
    const capped = activity.more || refresh.more || merged.length > WINDOW_LIMIT

    return { events, capped }
  },
})

/**
 * Health summary for the page's strip — "is the vault fine?" answered
 * independently of the feed's filters. A sub "needs attention" if its refresh
 * grant has lapsed OR its most-recent refresh attempt did not succeed, so the
 * strip can never read healthy while a sub is failing. `lastRefreshAt` and the
 * active-machine count come from authoritative reads, not the filtered window.
 */
export const feedSummary = authenticatedQuery({
  args: {},
  returns: v.object({
    needsAttention: v.number(),
    activeMachines: v.number(),
    lastRefreshAt: v.optional(v.number()),
  }),
  handler: async (ctx) => {
    const [subscriptions, recentActivity, lastRefresh] = await Promise.all([
      ctx.db.query('subscriptions').collect(),
      ctx.db.query('machineActivity').withIndex('byAt').order('desc').take(SUMMARY_ACTIVITY_WINDOW),
      ctx.db.query('refreshLog').withIndex('byAt').order('desc').first(),
    ])

    const liveSubs = subscriptions.filter((s) => s.removedAt === undefined)
    // Latest refresh outcome per live sub, via the per-sub index (cheap point
    // reads — the vault has a small number of subs).
    const latestOutcomes = await Promise.all(
      liveSubs.map((s) =>
        ctx.db
          .query('refreshLog')
          .withIndex('bySubscriptionAndAt', (q) => q.eq('subscriptionId', s._id))
          .order('desc')
          .first()
      )
    )

    const now = Date.now()
    let needsAttention = 0
    liveSubs.forEach((s, i) => {
      const lapsed = s.refreshExpiresAt !== undefined && s.refreshExpiresAt <= now
      const latest = latestOutcomes[i]
      const failing = latest !== null && latest.outcome !== 'success'
      if (lapsed || failing) needsAttention += 1
    })

    const machines = new Set<string>()
    for (const row of recentActivity) machines.add(coalesceMachineId(row))

    return {
      needsAttention,
      activeMachines: machines.size,
      ...(lastRefresh !== null ? { lastRefreshAt: lastRefresh.at } : {}),
    }
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
  // CVLT-3 migration coalescing — see coalesceMachineId. Surfaces a stable,
  // non-empty key so the `machineId: v.string()` validator holds.
  const machineId = coalesceMachineId(row)
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
