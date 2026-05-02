/**
 * UsageBar — renders one Anthropic usage window (5h or 7d) as a labeled
 * progress bar with a countdown to reset.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8 (sub list cards
 * w/ usage bars).
 *
 * Backed by `subscriptions.usage5h` / `usage7d` rows shaped per spec §4:
 *   { pct: number; resetsAt: number; fetchedAt: number }
 *
 * `usage` may be undefined when:
 *   - The poll cron hasn't run yet for a freshly-added sub
 *   - The account is Pro and Anthropic doesn't return a 7-day window
 *   - The previous fetch hit 401/429/5xx (we keep the last-known value
 *     in place but never invent one)
 *
 * Critical visual variant kicks in at >=90% so the user notices when an
 * account is about to throttle.
 */
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

export type UsageWindow = {
  pct: number
  resetsAt: number
  fetchedAt: number
}

export type UsageBarProps = {
  /** Display label, e.g. "5h" or "7d". */
  label: string
  /** Usage data; undefined when not yet polled or unavailable for the tier. */
  usage: UsageWindow | undefined
}

const CRITICAL_PCT = 90

/**
 * Format the time remaining until `resetsAt` as a short, human string.
 *
 * Mirrors the format used by claude-swap (see docs/research/anthropic-usage.md
 * §"claude-swap normalized shape"):
 *   > 1d  -> "Xd Xh"
 *   > 1h  -> "Xh Xm"
 *   else  -> "Xm"
 *   past  -> "now"
 */
export function formatCountdown(resetsAt: number, now: number = Date.now()): string {
  const ms = resetsAt - now
  if (ms <= 0) return 'now'

  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60)
  const minutes = totalMinutes - days * 60 * 24 - hours * 60

  if (days > 0) return `${days.toString()}d ${hours.toString()}h`
  if (hours > 0) return `${hours.toString()}h ${minutes.toString()}m`
  return `${minutes.toString()}m`
}

export function UsageBar({ label, usage }: UsageBarProps) {
  const isCritical = usage !== undefined && usage.pct >= CRITICAL_PCT
  const state = isCritical ? 'critical' : 'normal'

  return (
    <div
      data-slot="usage-bar"
      data-state={state}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground font-medium">{label}</span>
        <span
          className={cn(
            'tabular-nums font-medium',
            isCritical ? 'text-destructive' : 'text-foreground'
          )}
        >
          {usage !== undefined ? `${Math.round(usage.pct).toString()}%` : '—'}
        </span>
      </div>
      <Progress
        value={usage !== undefined ? Math.min(100, Math.max(0, usage.pct)) : 0}
        className={cn('h-1.5', isCritical && '[&>div]:bg-destructive')}
        aria-label={`${label} usage`}
      />
      {usage !== undefined && (
        <div className="text-muted-foreground text-xs">
          resets in {formatCountdown(usage.resetsAt)}
        </div>
      )}
    </div>
  )
}
