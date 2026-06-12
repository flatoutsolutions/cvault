/**
 * ReloginBadge — visible warning that the refresh token itself is dead
 * and the user must re-add the account from the CLI.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §10.
 *
 * Backend signal: `subscriptions.refreshExpiresAt <= now` after the
 * `markReloginRequired` internal mutation clamps it. See
 * convex/subscriptions/mutations.ts:301 and the spec §5 commentary.
 */
import { AlertTriangle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'

export type ReloginBadgeProps = {
  /**
   * Refresh-token expiry in ms epoch. Optional because the column is
   * `v.optional(v.number())` and unset for fresh subs that haven't
   * been through a refresh cycle yet.
   */
  refreshExpiresAt: number | undefined
  /**
   * Current epoch-ms. The card passes its ticking `useNow()` value so the
   * badge flips in lock-step with the 5h "Ready" gate (which uses the same
   * clock) — otherwise an expiry passing on an open tab would drop "Ready"
   * while the badge lagged. Defaults to `Date.now()` for standalone use.
   */
  now?: number
}

export function ReloginBadge({ refreshExpiresAt, now = Date.now() }: ReloginBadgeProps) {
  if (refreshExpiresAt === undefined) return null
  if (refreshExpiresAt > now) return null

  return (
    <Badge variant="destructive" className="gap-1">
      <AlertTriangle className="size-3" aria-hidden />
      <span>Relogin required</span>
    </Badge>
  )
}
