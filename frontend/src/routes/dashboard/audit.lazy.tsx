/**
 * Lazy component for /dashboard/audit — the human-readable activity feed.
 *
 * Reads:
 *   - api.audit.feed.recentFeed          (merged, enriched activity window)
 *   - api.subscriptions.queries.listForUser (sub health for the summary strip)
 *
 * Design goals (CVLT audit readability):
 *   - Every row reads like a sentence: WHO · did what · to which sub · when ·
 *     and is it OK. Internal verbs and machine UUIDs are translated to
 *     plain language and labels server-side (see convex/audit/feed.ts).
 *   - A health summary strip answers "is the vault fine?" before scrolling.
 *   - Routine noise (successful auto-refreshes, bulk syncs) is hidden by
 *     default behind a toggle so the meaningful events stand out.
 *   - Filtering is correct: the feed is a fully-materialised bounded window,
 *     so client-side filters can't miss rows on an unloaded page (the old
 *     dual-cursor pagination made filters leaky).
 */
import { createLazyFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { useMemo, useState } from 'react'

import { describeEvent, eventStatus, isRoutine } from '@/components/dashboard/auditEvent'
import type { AuditEvent, EventStatus } from '@/components/dashboard/auditEvent'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

import { api } from '../../../../convex/_generated/api'

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const
const DEFAULT_PAGE_SIZE = 25

const STATUS_VALUES = ['all', 'ok', 'failed', 'attention'] as const
type StatusFilter = (typeof STATUS_VALUES)[number]

export const Route = createLazyFileRoute('/dashboard/audit')({
  component: AuditPage,
})

/** Exported for tests. Wired into TanStack Router via `Route` above. */
export function AuditPage() {
  const feed = useQuery(api.audit.feed.recentFeed, {})
  const subs = useQuery(api.subscriptions.queries.listForUser, {})

  const [subFilter, setSubFilter] = useState('all')
  const [machineFilter, setMachineFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [showRoutine, setShowRoutine] = useState(false)
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)

  const events = useMemo(() => feed?.events ?? [], [feed])

  // Distinct machines present in the feed, for the Machine filter. Labels
  // come from the enriched event; fall back to a shortened id.
  const machines = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of events) {
      if (e.kind === 'activity') map.set(e.machineId, e.machineLabel ?? `${e.machineId.slice(0, 8)}…`)
    }
    return Array.from(map, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [events])

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (!showRoutine && isRoutine(e)) return false
      if (subFilter !== 'all' && e.subEmail !== subFilter) return false
      if (machineFilter !== 'all' && (e.kind !== 'activity' || e.machineId !== machineFilter)) return false
      if (statusFilter !== 'all' && eventStatus(e) !== statusFilter) return false
      return true
    })
  }, [events, showRoutine, subFilter, machineFilter, statusFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePageIndex = Math.min(pageIndex, totalPages - 1)
  const pageRows = filtered.slice(safePageIndex * pageSize, safePageIndex * pageSize + pageSize)

  // Health summary. A sub "needs attention" if its refresh grant has lapsed, OR
  // its most-recent refresh attempt in the window did not succeed (failure /
  // reloginRequired). Folding in the latest in-window outcome keeps the strip
  // honest — it can no longer read "✓ Vault healthy" while the feed below shows
  // that same sub's refresh failing. `activeMachines` reuses the `machines`
  // derivation rather than re-scanning events for the same distinct set.
  const summary = useMemo(() => {
    const now = Date.now()
    const liveEmails = new Set((subs ?? []).map((s) => s.email))
    const problem = new Set<string>()
    const latestSeen = new Set<string>()
    for (const e of events) {
      if (e.kind !== 'refresh' || e.subEmail === undefined || latestSeen.has(e.subEmail)) continue
      latestSeen.add(e.subEmail)
      if (e.outcome !== 'success' && liveEmails.has(e.subEmail)) problem.add(e.subEmail)
    }
    for (const s of subs ?? []) {
      if (s.refreshExpiresAt !== undefined && s.refreshExpiresAt <= now) problem.add(s.email)
    }
    const lastRefreshAt = events.reduce<number | undefined>(
      (acc, e) => (e.kind === 'refresh' ? Math.max(acc ?? 0, e.at) : acc),
      undefined
    )
    return { needsAttention: problem.size, lastRefreshAt, activeMachines: machines.length }
  }, [subs, events, machines])

  function resetToFirstPage() {
    setPageIndex(0)
  }

  if (feed === undefined) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    )
  }

  // `filtered` is empty while the feed has events only because some filter (or
  // the default routine-hide) removed them all, so this is always a
  // filters-active state — no separate guard needed.
  const nothingMatches = events.length > 0 && filtered.length === 0

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-muted-foreground text-sm">
          Who did what across the shared vault, and whether it&apos;s healthy.
        </p>
      </div>

      <HealthStrip
        needsAttention={summary.needsAttention}
        lastRefreshAt={summary.lastRefreshAt}
        activeMachines={summary.activeMachines}
      />

      <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <FilterSelect
          label="Sub"
          ariaLabel="Filter by subscription"
          value={subFilter}
          onChange={(v) => {
            setSubFilter(v)
            resetToFirstPage()
          }}
          options={[
            { value: 'all', label: 'All subs' },
            ...(subs ?? []).map((s) => ({ value: s.email, label: s.email })),
          ]}
        />
        <FilterSelect
          label="Machine"
          ariaLabel="Filter by machine"
          value={machineFilter}
          onChange={(v) => {
            setMachineFilter(v)
            resetToFirstPage()
          }}
          options={[{ value: 'all', label: 'All machines' }, ...machines.map((m) => ({ value: m.id, label: m.label }))]}
        />
        <FilterSelect
          label="Status"
          ariaLabel="Filter by status"
          value={statusFilter}
          onChange={(v) => {
            if ((STATUS_VALUES as readonly string[]).includes(v)) setStatusFilter(v as StatusFilter)
            resetToFirstPage()
          }}
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'ok', label: 'OK' },
            { value: 'failed', label: 'Failed' },
            { value: 'attention', label: 'Needs attention' },
          ]}
        />
        <Button
          type="button"
          variant={showRoutine ? 'default' : 'outline'}
          size="sm"
          aria-pressed={showRoutine}
          onClick={() => {
            setShowRoutine((v) => !v)
            resetToFirstPage()
          }}
        >
          {showRoutine ? 'Hiding nothing' : 'Show routine events'}
        </Button>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {filtered.length.toString()} {filtered.length === 1 ? 'event' : 'events'}
          {feed.capped ? ' · showing the most recent 500' : ''}
        </span>
      </div>

      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>Who</TableHead>
              <TableHead>Did what</TableHead>
              <TableHead>Subscription</TableHead>
              <TableHead>Machine</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground p-8 text-center text-sm">
                  {!nothingMatches
                    ? 'No activity yet.'
                    : feed.capped
                      ? 'No matching events in the most recent 500. Older history is not searched here — try widening the filters or showing routine events.'
                      : 'No events match the current filters. Try widening them or showing routine events.'}
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((e) => <EventRow key={`${e.kind}-${e.id}`} event={e} />)
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="text-muted-foreground tabular-nums">
          Page {(safePageIndex + 1).toString()} of {totalPages.toString()}
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="rows-per-page" className="text-muted-foreground inline-flex items-center gap-2">
            <span>Rows per page</span>
            <Select
              value={pageSize.toString()}
              onValueChange={(v) => {
                setPageSize(Number(v))
                resetToFirstPage()
              }}
            >
              <SelectTrigger id="rows-per-page" size="sm" aria-label="Rows per page" className="h-7 w-[68px]">
                <SelectValue placeholder={pageSize.toString()} />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={size.toString()}>
                    {size.toString()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPageIndex(0)}
              disabled={safePageIndex === 0}
              aria-label="First page"
            >
              First
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
              disabled={safePageIndex === 0}
              aria-label="Previous page"
            >
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPageIndex((i) => Math.min(totalPages - 1, i + 1))}
              disabled={safePageIndex >= totalPages - 1}
              aria-label="Next page"
            >
              Next
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPageIndex(totalPages - 1)}
              disabled={safePageIndex >= totalPages - 1}
              aria-label="Last page"
            >
              Last
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function HealthStrip({
  needsAttention,
  lastRefreshAt,
  activeMachines,
}: {
  needsAttention: number
  lastRefreshAt: number | undefined
  activeMachines: number
}) {
  const healthy = needsAttention === 0
  return (
    <div
      data-slot="health-strip"
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border p-3 text-sm',
        healthy ? 'border-border bg-card' : 'border-destructive/40 bg-destructive/5'
      )}
    >
      <span className={cn('font-medium', healthy ? 'text-foreground' : 'text-destructive')}>
        {healthy
          ? '✓ Vault healthy'
          : `⚠ ${needsAttention.toString()} ${needsAttention === 1 ? 'subscription needs' : 'subscriptions need'} attention`}
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="text-muted-foreground">
        {activeMachines.toString()} {activeMachines === 1 ? 'machine' : 'machines'} active
      </span>
      {lastRefreshAt !== undefined ? (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">last refresh {relativeTime(lastRefreshAt)}</span>
        </>
      ) : null}
    </div>
  )
}

function EventRow({ event }: { event: AuditEvent }) {
  const status = eventStatus(event)
  const isActivity = event.kind === 'activity'
  // Debug affordance: opaque machine id + ip hash on hover, never in the cell.
  const debugTitle = isActivity
    ? [event.machineId, event.ipHash !== undefined ? `IP: ${event.ipHash}` : undefined].filter(Boolean).join(' · ')
    : undefined

  return (
    <TableRow
      data-slot="audit-row"
      data-status={status}
      className={cn(status === 'failed' && 'bg-destructive/5', status === 'attention' && 'bg-amber-500/5')}
      title={debugTitle}
    >
      <TableCell>
        <WhoCell event={event} />
      </TableCell>
      <TableCell>
        <span className="font-medium">{describeEvent(event)}</span>
        {event.kind === 'refresh' && event.error !== undefined && status !== 'ok' ? (
          <div className="text-muted-foreground font-mono text-xs">{event.error}</div>
        ) : null}
      </TableCell>
      <TableCell>
        {event.subEmail !== undefined ? event.subEmail : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell>
        {event.kind === 'activity' ? (
          <span>{event.machineLabel ?? <span className="text-muted-foreground italic">unknown</span>}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs tabular-nums">{relativeTime(event.at)}</TableCell>
      <TableCell>
        <StatusBadge status={status} />
      </TableCell>
    </TableRow>
  )
}

function WhoCell({ event }: { event: AuditEvent }) {
  if (event.kind === 'refresh') {
    return <span className="text-muted-foreground">⚙ System</span>
  }
  const name = event.actor?.name ?? event.machineLabel ?? 'Unknown'
  return (
    <span className="inline-flex items-center gap-2">
      <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium">
        {initialsOf(name)}
      </span>
      <span className="truncate">{name}</span>
    </span>
  )
}

function StatusBadge({ status }: { status: EventStatus }) {
  if (status === 'ok') return <span className="text-muted-foreground text-xs">OK</span>
  if (status === 'failed') return <span className="text-destructive text-xs font-medium">Failed</span>
  return <span className="text-xs font-medium text-amber-600 dark:text-amber-500">Re-login needed</span>
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return parts
    .slice(0, 2)
    .map((p) => p.charAt(0))
    .join('')
    .toUpperCase()
}

function FilterSelect({
  label,
  ariaLabel,
  value,
  onChange,
  options,
}: {
  label: string
  ariaLabel: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="text-muted-foreground inline-flex items-center gap-2 text-xs">
      <span className="font-medium uppercase tracking-wide">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" aria-label={ariaLabel} className="h-7 w-[150px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}
