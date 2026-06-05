/**
 * auditEvent — presentation helpers for the `/dashboard/audit` feed.
 *
 * Turns a raw event from `api.audit.feed.recentFeed` into the plain-language
 * label, status, and routine-classification the page renders. The goal is a
 * row that reads like a sentence ("Alice · Switched subscription · team@acme")
 * instead of an internal verb + UUID.
 *
 * The `AuditEvent` type is derived from the query return so it tracks the
 * backend validator automatically.
 */
import type { FunctionReturnType } from 'convex/server'

import type { api } from '../../../../convex/_generated/api'

export type AuditEvent = FunctionReturnType<typeof api.audit.feed.recentFeed>['events'][number]

/** A CLI-activity event (narrowed from the union). */
export type ActivityEvent = Extract<AuditEvent, { kind: 'activity' }>
/** A token-refresh event (narrowed from the union). */
export type RefreshEvent = Extract<AuditEvent, { kind: 'refresh' }>

export type EventStatus = 'ok' | 'failed' | 'attention'

const ACTIVITY_LABELS: Record<ActivityEvent['action'], string> = {
  switch: 'Switched subscription',
  add: 'Added subscription',
  pull: 'Synced credentials',
  remove: 'Removed subscription',
  refresh: 'Refreshed token',
  rename: 'Renamed subscription',
  login: 'Signed in',
  export: 'Exported a backup',
  import: 'Imported a backup',
  rotate: 'Rotated encryption key',
}

const REFRESH_LABELS: Record<RefreshEvent['outcome'], string> = {
  success: 'Token refreshed',
  failure: 'Token refresh failed',
  reloginRequired: 'Re-login required',
}

/** Plain-language description of what happened. */
export function describeEvent(event: AuditEvent): string {
  return event.kind === 'activity' ? ACTIVITY_LABELS[event.action] : REFRESH_LABELS[event.outcome]
}

/** Health classification used for the status badge + row tint. */
export function eventStatus(event: AuditEvent): EventStatus {
  if (event.kind === 'activity') return 'ok'
  if (event.outcome === 'success') return 'ok'
  if (event.outcome === 'reloginRequired') return 'attention'
  return 'failed'
}

/**
 * Routine = high-volume, low-signal events that bury the meaningful ones:
 * successful automatic token refreshes and whole-bundle credential syncs.
 * The page hides these by default behind a "show routine events" toggle.
 */
export function isRoutine(event: AuditEvent): boolean {
  if (event.kind === 'refresh') return event.outcome === 'success'
  return event.action === 'pull'
}
