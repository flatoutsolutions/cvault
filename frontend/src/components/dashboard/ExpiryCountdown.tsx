/**
 * ExpiryCountdown — relative countdown to the access token's `expiresAt`.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Token expiry is what the cron and the on-use refresh actions check
 * against (`REFRESH_PROACTIVE_MS = 5 * 60 * 1000`). We mirror the same
 * 5-minute warning threshold here so the UI tells the user "this token
 * is about to be auto-refreshed" rather than scaring them.
 */
import { cn } from '@/lib/utils'

import { formatCountdown } from './UsageBar'

export type ExpiryCountdownProps = {
  /** Access-token expiry in ms epoch. */
  expiresAt: number
  /**
   * Current epoch-ms. The card passes its ticking `useNow()` value so the
   * countdown ages on a long-open tab instead of freezing between Convex
   * pushes. Defaults to `Date.now()` for standalone use.
   */
  now?: number
}

const WARNING_WINDOW_MS = 5 * 60 * 1000

type State = 'ok' | 'warning' | 'expired'

function deriveState(expiresAt: number, now: number): State {
  const ms = expiresAt - now
  if (ms <= 0) return 'expired'
  if (ms <= WARNING_WINDOW_MS) return 'warning'
  return 'ok'
}

export function ExpiryCountdown({ expiresAt, now = Date.now() }: ExpiryCountdownProps) {
  const state = deriveState(expiresAt, now)

  return (
    <div
      data-slot="expiry-countdown"
      data-state={state}
      className={cn(
        'text-muted-foreground inline-flex items-center gap-1 text-xs',
        state === 'warning' && 'text-amber-500 dark:text-amber-400',
        state === 'expired' && 'text-destructive'
      )}
    >
      {state === 'expired' ? (
        <span>token expired</span>
      ) : (
        <span>
          expires in <span className="tabular-nums">{formatCountdown(expiresAt, now)}</span>
        </span>
      )}
    </div>
  )
}
