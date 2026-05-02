/**
 * /dashboard/audit — merged feed of refreshLog + machineActivity.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Reads:
 *   - api.refreshLog.queries.recentForUser     (refresh attempts)
 *   - api.machineActivity.queries.recentForUser (CLI operations)
 *   - api.subscriptions.queries.listForUser     (so we can join subId → email)
 *
 * Filters (all client-side):
 *   - subEmail (or "all")
 *   - clerkSessionId (or "all")
 *   - outcome (success / failure / reloginRequired / activity / "all")
 */
import { useQuery } from 'convex/react'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import type { AuditRowData } from '@/components/dashboard/AuditRow'
import { AuditRow } from '@/components/dashboard/AuditRow'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '../../../../convex/_generated/api'

export const Route = createFileRoute('/dashboard/audit')({
  component: AuditPage,
})

type Filter = 'all' | 'success' | 'failure' | 'reloginRequired' | 'activity'

/**
 * Exported for tests. Wired into TanStack Router via `Route` above.
 */
export function AuditPage() {
  const refreshLog = useQuery(api.refreshLog.queries.recentForUser, { limit: 200 })
  const machineActivity = useQuery(api.machineActivity.queries.recentForUser, { limit: 200 })
  const subs = useQuery(api.subscriptions.queries.listForUser, {})

  const [subFilter, setSubFilter] = useState<string>('all')
  const [sessionFilter, setSessionFilter] = useState<string>('all')
  const [outcomeFilter, setOutcomeFilter] = useState<Filter>('all')

  const subEmailById = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of subs ?? []) {
      map.set(s._id, s.email)
    }
    return map
  }, [subs])

  const merged = useMemo<AuditRowData[]>(() => {
    if (refreshLog === undefined || machineActivity === undefined) return []

    const refreshRows: AuditRowData[] = refreshLog.map((r) => ({
      kind: 'refresh',
      id: r._id,
      at: r.at,
      subEmail: subEmailById.get(r.subscriptionId),
      triggeredBy: r.triggeredBy,
      outcome: r.outcome,
      error: r.error,
    }))

    const activityRows: AuditRowData[] = machineActivity.map((a) => ({
      kind: 'activity',
      id: a._id,
      at: a.at,
      subEmail: a.subscriptionId !== undefined ? subEmailById.get(a.subscriptionId) : undefined,
      action: a.action,
      ipHash: a.ipHash,
      clerkSessionId: a.clerkSessionId,
    }))

    return [...refreshRows, ...activityRows].sort((a, b) => b.at - a.at)
  }, [refreshLog, machineActivity, subEmailById])

  const filtered = useMemo(() => {
    return merged.filter((row) => {
      if (subFilter !== 'all' && row.subEmail !== subFilter) return false
      if (sessionFilter !== 'all') {
        if (row.kind !== 'activity' || row.clerkSessionId !== sessionFilter) return false
      }
      if (outcomeFilter !== 'all') {
        if (outcomeFilter === 'activity') {
          if (row.kind !== 'activity') return false
        } else {
          if (row.kind !== 'refresh' || row.outcome !== outcomeFilter) return false
        }
      }
      return true
    })
  }, [merged, subFilter, sessionFilter, outcomeFilter])

  // Distinct session ids appearing in machineActivity, for the filter dropdown.
  const sessionIds = useMemo(() => {
    const set = new Set<string>()
    for (const a of machineActivity ?? []) {
      set.add(a.clerkSessionId)
    }
    return Array.from(set).sort()
  }, [machineActivity])

  if (refreshLog === undefined || machineActivity === undefined) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit</h1>
        <p className="text-muted-foreground text-sm">
          Refresh attempts and CLI operations across all your machines.
        </p>
      </div>

      <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <FilterSelect
          label="Sub"
          value={subFilter}
          onChange={setSubFilter}
          options={[
            { value: 'all', label: 'All subs' },
            ...(subs ?? []).map((s) => ({ value: s.email, label: s.email })),
          ]}
        />
        <FilterSelect
          label="Machine"
          value={sessionFilter}
          onChange={setSessionFilter}
          options={[
            { value: 'all', label: 'All machines' },
            ...sessionIds.map((id) => ({ value: id, label: `${id.slice(0, 14)}…` })),
          ]}
        />
        <FilterSelect
          label="Outcome"
          value={outcomeFilter}
          onChange={(v) => {
            setOutcomeFilter(v as Filter)
          }}
          options={[
            { value: 'all', label: 'All outcomes' },
            { value: 'success', label: 'Success (refresh)' },
            { value: 'failure', label: 'Failure (refresh)' },
            { value: 'reloginRequired', label: 'Relogin required' },
            { value: 'activity', label: 'CLI activity only' },
          ]}
        />
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {filtered.length.toString()} of {merged.length.toString()} rows
        </span>
      </div>

      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className="border-border text-muted-foreground grid grid-cols-[110px_120px_1fr_140px_110px] gap-3 border-b px-4 py-2 text-xs font-medium uppercase tracking-wide">
          <div>kind</div>
          <div>outcome</div>
          <div>detail</div>
          <div>ip</div>
          <div>when</div>
        </div>
        {filtered.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            No audit rows match the current filters.
          </div>
        ) : (
          filtered.map((row) => <AuditRow key={`${row.kind}-${row.id}`} row={row} />)
        )}
      </div>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="text-muted-foreground inline-flex items-center gap-2 text-xs">
      <span className="font-medium uppercase tracking-wide">{label}</span>
      <select
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
        }}
        className="border-border bg-background text-foreground rounded-md border px-2 py-1 text-xs"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
