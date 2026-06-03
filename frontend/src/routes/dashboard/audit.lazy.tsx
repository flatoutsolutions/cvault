/**
 * Lazy component for /dashboard/audit — split out per Track B item 9.
 *
 * Reads:
 *   - api.refreshLog.queries.recentForUser     (refresh attempts)
 *   - api.machineActivity.queries.recentForUser (CLI operations)
 *   - api.subscriptions.queries.listForUser     (so we can join subId → email)
 *
 * Filters (all client-side):
 *   - subEmail (or "all")
 *   - machineId (or "all")
 *   - outcome (success / failure / reloginRequired / activity / "all")
 *
 * Pagination is server-side via Convex `usePaginatedQuery`. The two
 * paginated streams are merged client-side, sorted desc by `at`, and
 * sliced into pages by TanStack Table in `manualPagination` mode.
 *
 *   - Page sizes: 10, 25, 50, 100 (default 25)
 *   - First / Prev / Next / Last buttons
 *   - Indicator: "Page X of Y · N rows loaded"
 *   - When EITHER source is not yet `Exhausted` we don't know the total
 *     row count, so the indicator shows "?" and the "Last" button is
 *     disabled. Clicking "Next" past the loaded data triggers `loadMore`
 *     on whichever stream has more rows available.
 */
import { createLazyFileRoute } from '@tanstack/react-router'
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import type { ColumnDef, PaginationState } from '@tanstack/react-table'
import { usePaginatedQuery, useQuery } from 'convex/react'
import { useMemo, useState } from 'react'

import type { AuditRowData } from '@/components/dashboard/AuditRow'
import { relativeTime } from '@/components/dashboard/AuditRow'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

import { api } from '../../../../convex/_generated/api'

// One server page is 50 rows. The audit feed is append-only and grows on
// every `cvault refresh / switch / add / pull / login` — paginating
// keeps the initial fetch snappy. We request a fresh batch from the
// server whenever the user advances past the loaded data.
const SERVER_PAGE_SIZE = 50
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const
const DEFAULT_PAGE_SIZE = 25

export const Route = createLazyFileRoute('/dashboard/audit')({
  component: AuditPage,
})

const FILTER_VALUES = ['all', 'success', 'failure', 'reloginRequired', 'activity'] as const
type Filter = (typeof FILTER_VALUES)[number]

function isFilter(value: string): value is Filter {
  return (FILTER_VALUES as readonly string[]).includes(value)
}

/**
 * Exported for tests. Wired into TanStack Router via `Route` above.
 */
export function AuditPage() {
  const {
    results: refreshLog,
    status: refreshStatus,
    loadMore: loadMoreRefresh,
  } = usePaginatedQuery(api.refreshLog.queries.recentForUser, {}, { initialNumItems: SERVER_PAGE_SIZE })
  const {
    results: machineActivity,
    status: activityStatus,
    loadMore: loadMoreActivity,
  } = usePaginatedQuery(api.machineActivity.queries.recentForUser, {}, { initialNumItems: SERVER_PAGE_SIZE })
  const subs = useQuery(api.subscriptions.queries.listForUser, {})

  const [subFilter, setSubFilter] = useState<string>('all')
  const [sessionFilter, setSessionFilter] = useState<string>('all')
  const [outcomeFilter, setOutcomeFilter] = useState<Filter>('all')

  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  })

  const subEmailById = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of subs ?? []) {
      map.set(s._id, s.email)
    }
    return map
  }, [subs])

  const merged = useMemo<AuditRowData[]>(() => {
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
      machineId: a.machineId,
    }))

    return [...refreshRows, ...activityRows].sort((a, b) => b.at - a.at)
  }, [refreshLog, machineActivity, subEmailById])

  const filtered = useMemo(() => {
    return merged.filter((row) => {
      if (subFilter !== 'all' && row.subEmail !== subFilter) return false
      if (sessionFilter !== 'all') {
        if (row.kind !== 'activity' || row.machineId !== sessionFilter) return false
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
    for (const a of machineActivity) {
      set.add(a.machineId)
    }
    return Array.from(set).sort()
  }, [machineActivity])

  // Pagination math. Both paginated streams must be `Exhausted` before
  // we know the true total — otherwise the user could click "Next" past
  // loaded data and we need to fetch more.
  const isExhausted = refreshStatus === 'Exhausted' && activityStatus === 'Exhausted'
  const canLoadMore = refreshStatus === 'CanLoadMore' || activityStatus === 'CanLoadMore'
  const isLoadingMore = refreshStatus === 'LoadingMore' || activityStatus === 'LoadingMore'
  const totalLoadedAfterFilter = filtered.length
  const totalPages = isExhausted ? Math.max(1, Math.ceil(totalLoadedAfterFilter / pagination.pageSize)) : null

  // Slice the filtered, merged rows by current page. We do this manually
  // (vs. `getPaginationRowModel`) so the table doesn't see rows beyond
  // the current page — keeps row identity stable across pages and lets
  // us hand TanStack Table `manualPagination`.
  const pageRows = useMemo(() => {
    const start = pagination.pageIndex * pagination.pageSize
    return filtered.slice(start, start + pagination.pageSize)
  }, [filtered, pagination])

  const columns = useMemo<ColumnDef<AuditRowData>[]>(
    () => [
      {
        id: 'kind',
        header: 'Kind',
        cell: ({ row }) => <KindCell row={row.original} />,
      },
      {
        id: 'outcome',
        header: 'Outcome',
        cell: ({ row }) => <OutcomeCell row={row.original} />,
      },
      {
        id: 'detail',
        header: 'Detail',
        cell: ({ row }) => <DetailCell row={row.original} />,
      },
      {
        id: 'ip',
        header: 'IP',
        cell: ({ row }) => <IpCell row={row.original} />,
      },
      {
        id: 'when',
        header: 'When',
        cell: ({ row }) => <WhenCell row={row.original} />,
      },
    ],
    []
  )

  const table = useReactTable({
    data: pageRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: totalPages ?? -1,
    state: { pagination },
    onPaginationChange: setPagination,
  })

  // First-page loading skeleton: only shown while BOTH paginated queries
  // are still on their initial fetch. After that we render rows
  // incrementally.
  if (refreshStatus === 'LoadingFirstPage' && activityStatus === 'LoadingFirstPage') {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    )
  }

  function changePageSize(next: number) {
    setPagination({ pageIndex: 0, pageSize: next })
    // Reset to first page; if the new size needs more rows than we've
    // loaded so far, the next "Next" click will trigger loadMore.
  }

  function goNext() {
    const nextIndex = pagination.pageIndex + 1
    const needRows = (nextIndex + 1) * pagination.pageSize
    if (needRows > filtered.length && canLoadMore) {
      // Prefetch enough rows to cover this page (and a small buffer).
      if (refreshStatus === 'CanLoadMore') loadMoreRefresh(SERVER_PAGE_SIZE)
      if (activityStatus === 'CanLoadMore') loadMoreActivity(SERVER_PAGE_SIZE)
    }
    setPagination((p) => ({ ...p, pageIndex: nextIndex }))
  }

  function goPrev() {
    setPagination((p) => ({ ...p, pageIndex: Math.max(0, p.pageIndex - 1) }))
  }

  function goFirst() {
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }

  function goLast() {
    if (totalPages === null) return // disabled in UI when not exhausted
    setPagination((p) => ({ ...p, pageIndex: Math.max(0, totalPages - 1) }))
  }

  // Disable rules for the four nav buttons.
  const isFirstPage = pagination.pageIndex === 0
  const isLastPageKnown = totalPages !== null && pagination.pageIndex >= totalPages - 1
  const nextDisabled = isLastPageKnown || isLoadingMore
  const prevDisabled = isFirstPage
  const firstDisabled = isFirstPage
  const lastDisabled = totalPages === null || isLastPageKnown

  // "Filter narrowed everything away" empty state: data is loaded, the
  // user has rows in the merged feed, but the active filters exclude
  // them all. Distinguished from the unfiltered empty case (kept inside
  // the table body below) so users get an actionable hint to widen the
  // filter set rather than concluding the feed is empty.
  const filtersActive = subFilter !== 'all' || sessionFilter !== 'all' || outcomeFilter !== 'all'
  const filteredAwayEmpty = filtersActive && merged.length > 0 && filtered.length === 0

  // Page indicator strings.
  const pageNumber = pagination.pageIndex + 1
  const totalPagesText = totalPages === null ? '?' : totalPages.toString()
  const rowsLoadedText = `${totalLoadedAfterFilter.toString()} rows loaded`

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit</h1>
        <p className="text-muted-foreground text-sm">Refresh attempts and CLI operations across all your machines.</p>
      </div>

      <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <FilterSelect
          label="Sub"
          value={subFilter}
          onChange={(v) => {
            setSubFilter(v)
            setPagination((p) => ({ ...p, pageIndex: 0 }))
          }}
          options={[
            { value: 'all', label: 'All subs' },
            ...(subs ?? []).map((s) => ({ value: s.email, label: s.email })),
          ]}
        />
        <FilterSelect
          label="Machine"
          value={sessionFilter}
          onChange={(v) => {
            setSessionFilter(v)
            setPagination((p) => ({ ...p, pageIndex: 0 }))
          }}
          options={[
            { value: 'all', label: 'All machines' },
            ...sessionIds.map((id) => ({ value: id, label: `${id.slice(0, 14)}…` })),
          ]}
        />
        <FilterSelect
          label="Outcome"
          value={outcomeFilter}
          onChange={(v) => {
            if (isFilter(v)) {
              setOutcomeFilter(v)
            }
            setPagination((p) => ({ ...p, pageIndex: 0 }))
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

      {filteredAwayEmpty ? (
        <div className="border-border bg-card flex flex-col items-center gap-1 rounded-lg border p-8 text-center text-sm">
          <p className="text-foreground font-medium">No matching activity.</p>
          <p className="text-muted-foreground">Try clearing filters or expanding the date range.</p>
        </div>
      ) : null}

      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="bg-muted/30 hover:bg-muted/30">
                {hg.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="text-muted-foreground p-8 text-center text-sm">
                  No audit rows match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => {
                const original = row.original
                const state = original.kind === 'refresh' && original.outcome !== 'success' ? 'error' : 'ok'
                return (
                  <TableRow
                    key={`${original.kind}-${original.id}`}
                    data-slot="audit-row"
                    data-state={state}
                    className={cn(state === 'error' && 'bg-destructive/5')}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                    ))}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="text-muted-foreground tabular-nums">
          Page {pageNumber.toString()} of {totalPagesText} <span className="px-1">·</span> {rowsLoadedText}
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="rows-per-page" className="text-muted-foreground inline-flex items-center gap-2">
            <span>Rows per page</span>
            <Select
              value={pagination.pageSize.toString()}
              onValueChange={(v) => {
                changePageSize(Number(v))
              }}
            >
              <SelectTrigger id="rows-per-page" size="sm" aria-label="Rows per page" className="h-7 w-[68px]">
                <SelectValue placeholder={pagination.pageSize.toString()} />
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
            <Button variant="outline" size="sm" onClick={goFirst} disabled={firstDisabled} aria-label="First page">
              First
            </Button>
            <Button variant="outline" size="sm" onClick={goPrev} disabled={prevDisabled} aria-label="Previous page">
              Prev
            </Button>
            <Button variant="outline" size="sm" onClick={goNext} disabled={nextDisabled} aria-label="Next page">
              Next
            </Button>
            <Button variant="outline" size="sm" onClick={goLast} disabled={lastDisabled} aria-label="Last page">
              Last
            </Button>
          </div>
        </div>
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

// === Cell renderers — keep markup co-located with the table column defs.

function KindCell({ row }: { row: AuditRowData }) {
  // Refresh rows that didn't succeed (failure or reloginRequired) get
  // the destructive color. Activity rows are always neutral.
  const isError = row.kind === 'refresh' && row.outcome !== 'success'
  return (
    <div className="flex flex-col">
      <span className={cn('font-medium', isError ? 'text-destructive' : 'text-foreground')}>
        {row.kind === 'refresh' ? 'refresh' : row.action}
      </span>
      <span className="text-muted-foreground text-xs">{row.kind === 'refresh' ? row.triggeredBy : 'cli'}</span>
    </div>
  )
}

function OutcomeCell({ row }: { row: AuditRowData }) {
  if (row.kind === 'refresh') {
    if (row.outcome === 'reloginRequired') {
      return <span className="text-destructive text-xs">relogin required</span>
    }
    return <span className="text-muted-foreground text-xs">{row.outcome}</span>
  }
  return <span className="text-muted-foreground font-mono text-xs">{row.machineId.slice(0, 12)}…</span>
}

function DetailCell({ row }: { row: AuditRowData }) {
  if (row.kind === 'refresh' && row.outcome !== 'success' && row.error !== undefined) {
    return <span className="text-muted-foreground font-mono text-xs">{row.error}</span>
  }
  if (row.subEmail !== undefined) {
    return <span>{row.subEmail}</span>
  }
  return <span className="text-muted-foreground">—</span>
}

function IpCell({ row }: { row: AuditRowData }) {
  if (row.kind === 'activity' && row.ipHash !== undefined) {
    return <span className="text-muted-foreground font-mono text-xs">{row.ipHash}</span>
  }
  return <span className="text-muted-foreground font-mono text-xs">—</span>
}

function WhenCell({ row }: { row: AuditRowData }) {
  return <span className="text-muted-foreground text-xs tabular-nums">{relativeTime(row.at)}</span>
}
