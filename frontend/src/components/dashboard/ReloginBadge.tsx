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
}

export function ReloginBadge({ refreshExpiresAt }: ReloginBadgeProps) {
  if (refreshExpiresAt === undefined) return null
  if (refreshExpiresAt > Date.now()) return null

  return (
    <Badge variant="destructive" className="gap-1">
      <AlertTriangle className="size-3" aria-hidden />
      <span>Relogin required</span>
    </Badge>
  )
}
