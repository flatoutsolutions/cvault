/**
 * AuditRow — single row in the merged audit feed.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * The page (`/dashboard/audit`) merges:
 *   - refreshLog rows  → kind: 'refresh'
 *   - machineActivity rows → kind: 'activity'
 *
 * This component does no merging itself; it renders one normalized row.
 * Keeping the row shape defined here (vs. importing the Convex schema
 * types) lets the audit page do its own join/transform without coupling
 * the row component to backend types.
 */
import { cn } from '@/lib/utils'

export type AuditRefreshRow = {
  kind: 'refresh'
  id: string
  at: number
  subEmail: string | undefined
  triggeredBy: 'cron' | 'manual' | 'onUse'
  outcome: 'success' | 'failure' | 'reloginRequired'
  error?: string | undefined
}

export type AuditActivityRow = {
  kind: 'activity'
  id: string
  at: number
  subEmail: string | undefined
  action: 'switch' | 'add' | 'pull' | 'remove' | 'refresh' | 'rename' | 'login'
  ipHash: string | undefined
  clerkSessionId: string
}

export type AuditRowData = AuditRefreshRow | AuditActivityRow

function relativeTime(at: number, now: number = Date.now()): string {
  const ms = now - at
  if (ms < 0) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes.toString()}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours.toString()}h ago`
  const days = Math.floor(hours / 24)
  return `${days.toString()}d ago`
}

function deriveState(row: AuditRowData): 'ok' | 'error' {
  if (row.kind === 'refresh') {
    return row.outcome === 'success' ? 'ok' : 'error'
  }
  return 'ok'
}

export type AuditRowProps = {
  row: AuditRowData
}

export function AuditRow({ row }: AuditRowProps) {
  const state = deriveState(row)

  return (
    <div
      data-slot="audit-row"
      data-state={state}
      className={cn(
        'border-border grid grid-cols-[110px_120px_1fr_140px_110px] items-center gap-3 border-b px-4 py-3 text-sm',
        state === 'error' && 'bg-destructive/5'
      )}
    >
      {/* Kind / action label */}
      <div className="flex flex-col">
        <span
          className={cn(
            'font-medium',
            row.kind === 'refresh' && row.outcome === 'reloginRequired'
              ? 'text-destructive'
              : state === 'error'
                ? 'text-destructive'
                : 'text-foreground'
          )}
        >
          {row.kind === 'refresh' ? 'refresh' : row.action}
        </span>
        <span className="text-muted-foreground text-xs">{row.kind === 'refresh' ? row.triggeredBy : 'cli'}</span>
      </div>

      {/* Outcome (refresh) or session (activity) */}
      <div className="text-muted-foreground text-xs">
        {row.kind === 'refresh' ? (
          row.outcome === 'reloginRequired' ? (
            <span className="text-destructive">relogin required</span>
          ) : (
            <span>{row.outcome}</span>
          )
        ) : (
          <span className="font-mono">{row.clerkSessionId.slice(0, 12)}…</span>
        )}
      </div>

      {/* Sub email or error message */}
      <div className="min-w-0 truncate">
        {row.kind === 'refresh' && row.outcome !== 'success' && row.error ? (
          <span className="text-muted-foreground font-mono text-xs">{row.error}</span>
        ) : row.subEmail !== undefined ? (
          <span>{row.subEmail}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>

      {/* IP hash (activity) or empty */}
      <div className="text-muted-foreground font-mono text-xs">
        {row.kind === 'activity' && row.ipHash !== undefined ? row.ipHash : '—'}
      </div>

      {/* Time */}
      <div className="text-muted-foreground text-xs tabular-nums">{relativeTime(row.at)}</div>
    </div>
  )
}
