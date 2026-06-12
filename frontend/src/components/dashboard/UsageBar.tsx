/**
 * UsageBar — renders one Anthropic usage window (5h or 7d) as a labeled
 * progress bar with a countdown to reset.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8 (sub list cards
 * w/ usage bars). Note: §4's active-only usage shape is superseded — a window
 * is now the active/idle union below (CVLT-6).
 *
 * `usage` is `subscriptions.usage5h` / `usage7d`, a union of:
 *   - active `{ pct, resetsAt, fetchedAt }` — a live rate-limit window.
 *   - idle   `{ idle: true, fetchedAt }`    — a successful poll found no active
 *     window (e.g. a 5h window that reset). With `idlePresentation="ready"`
 *     this renders "Ready"; otherwise it renders like unknown ("—").
 *   - `undefined` — never successfully polled yet (the cron hasn't run for a
 *     freshly-added sub). A failed poll (401/429/5xx) does NOT land here: it
 *     preserves the last-known value rather than clearing it.
 *
 * Critical visual variant kicks in at >=90% so the user notices when an
 * account is about to throttle.
 *
 * Staleness (CVLT-7): a window older than `STALE_AFTER_MS` (3 missed polls) is
 * dimmed with a "last checked" hint, because a failed poll preserves last-known
 * and writes nothing — without this the value would silently rot. "Ready" is a
 * strong claim, so it shows ONLY when the idle window is fresh AND the token is
 * alive (`tokenAlive`); a stale or relogin-required sub degrades instead of
 * over-claiming. `now` is injected so the countdown + staleness tick on a
 * long-open tab (see `useNow`).
 */
import { Check } from 'lucide-react'

import { Progress } from '@/components/ui/progress'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

/**
 * A usage window is either ACTIVE (a live rate-limit window with a percentage
 * and reset time) or IDLE (a successful poll found no active window — e.g. a
 * 5h session window that has reset; a fresh one only starts on the next use).
 * `undefined` means not-yet-polled / unavailable for the tier.
 */
export type UsageWindow = { pct: number; resetsAt: number; fetchedAt: number } | { idle: true; fetchedAt: number }

function isActive(usage: UsageWindow | undefined): usage is { pct: number; resetsAt: number; fetchedAt: number } {
  return usage !== undefined && 'pct' in usage
}

export type UsageBarProps = {
  /** Display label, e.g. "5h" or "7d". */
  label: string
  /** Usage data; undefined when not yet polled or unavailable for the tier. */
  usage: UsageWindow | undefined
  /**
   * How to render the IDLE state (no active window). `'ready'` shows an
   * affirmative "Ready" affordance for the 5h window — a reset 5h window means
   * full quota is available and the next `claude` command starts a fresh
   * 5-hour window. `'none'` (default) renders idle the same as unknown ("—"),
   * used for the 7d window where an absent window is ambiguous (a Pro account
   * has no weekly window at all, so "Ready" would mislead).
   */
  idlePresentation?: 'ready' | 'none'
  /**
   * Current epoch-ms. Injected so the reset countdown and staleness check tick
   * on a long-open tab (the card passes `useNow()`); tests pass a fixed value.
   * Defaults to `Date.now()` for standalone use.
   */
  now?: number
  /**
   * Whether the sub's token is still usable. When `false` (relogin-required)
   * the 5h window never claims "Ready" — a dead-token sub isn't usable
   * regardless of its last polled window; the card's ⚠ badge explains why.
   * Defaults to `true`.
   */
  tokenAlive?: boolean
}

const CRITICAL_PCT = 90
/** Usage older than this (3 missed 5-minute polls) is treated as stale. */
const STALE_AFTER_MS = 15 * 60 * 1000

/**
 * Format the time remaining until `resetsAt` as a short, human string.
 *
 * Format (see docs/research/anthropic-usage.md):
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

export function UsageBar({
  label,
  usage,
  idlePresentation = 'none',
  now = Date.now(),
  tokenAlive = true,
}: UsageBarProps) {
  const active = isActive(usage)
  const isIdle = usage !== undefined && 'idle' in usage
  const stale = usage !== undefined && now - usage.fetchedAt > STALE_AFTER_MS
  // "Ready" requires a CONFIRMED idle window, the affordance opt-in (5h), FRESH
  // data, and a live token. Otherwise we degrade rather than over-claim.
  const ready = isIdle && idlePresentation === 'ready' && !stale && tokenAlive
  // Idle window we still trust the *state* of but whose data is old: show a
  // muted "Ready" + "last checked" instead of the confident affordance. A
  // dead-token sub drops to "—" (the ready/idleStale guards both fail).
  const idleStale = isIdle && idlePresentation === 'ready' && tokenAlive && stale
  const isCritical = active && usage.pct >= CRITICAL_PCT
  const state = isCritical ? 'critical' : ready ? 'ready' : stale ? 'stale' : 'normal'
  const checkedAgo = usage !== undefined ? relativeTime(usage.fetchedAt, now) : ''

  return (
    <div data-slot="usage-bar" data-state={state} className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground font-medium">{label}</span>
        {active ? (
          <span
            className={cn(
              'tabular-nums font-medium',
              isCritical ? 'text-destructive' : stale ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {Math.round(usage.pct).toString()}%
          </span>
        ) : ready ? (
          <span className="text-foreground inline-flex items-center gap-0.5 font-medium">
            <Check className="size-3" aria-hidden />
            Ready
          </span>
        ) : idleStale ? (
          <span className="text-muted-foreground font-medium">Ready</span>
        ) : (
          <span className="text-foreground font-medium">—</span>
        )}
      </div>
      <Progress
        value={active ? Math.min(100, Math.max(0, usage.pct)) : 0}
        className={cn('h-1.5', isCritical && '[&>div]:bg-destructive', stale && 'opacity-50')}
        aria-label={`${label} usage`}
      />
      {active ? (
        <div className="text-muted-foreground text-xs">
          resets in {formatCountdown(usage.resetsAt, now)}
          {stale ? ` · checked ${checkedAgo}` : ''}
        </div>
      ) : ready ? (
        <div className="text-muted-foreground text-xs">fresh window starts on next use</div>
      ) : idleStale ? (
        <div className="text-muted-foreground text-xs">last checked {checkedAgo}</div>
      ) : null}
    </div>
  )
}
