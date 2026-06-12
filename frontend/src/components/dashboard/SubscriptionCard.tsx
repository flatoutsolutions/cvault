/**
 * SubscriptionCard — primary card on /dashboard, one per active sub.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Composes UsageBar, ExpiryCountdown, and ReloginBadge. Per-card actions
 * (Force Refresh / Rename / Remove) are passed in as callbacks so the
 * route owns the Convex calls and the component is easy to test.
 *
 * Type contract: `SubscriptionMeta` is the array element returned by
 * `api.subscriptions.queries.listForUser`. We derive it via the
 * generated `api` and `FunctionReturnType` so the card automatically
 * stays in sync with the backend's validator.
 */
import type { FunctionReturnType } from 'convex/server'
import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatRelativeAgo } from '@/lib/time'

import type { api } from '../../../../convex/_generated/api'
import { AvatarStack } from './AvatarStack'
import type { SubscriptionUser } from './AvatarStack'
import { ExpiryCountdown } from './ExpiryCountdown'
import { ReloginBadge } from './ReloginBadge'
import { UsageBar } from './UsageBar'

/**
 * Element type of `api.subscriptions.queries.listForUser`'s return array.
 * Derived from the generated API so it tracks the backend validator.
 */
export type SubscriptionMeta = FunctionReturnType<typeof api.subscriptions.queries.listForUser>[number]

export type SubscriptionCardProps = {
  sub: SubscriptionMeta
  onForceRefresh: (args: { email: string }) => void
  onRename: (args: { email: string; label: string }) => void
  onRemove: (args: { email: string }) => void
  forceRefreshing: boolean
  /** When set, the most recent Force Refresh attempt failed with this message. */
  forceRefreshError?: string
  removing: boolean
  /** People who recently used this subscription, for the footer avatar stack. */
  users: SubscriptionUser[]
}

export function SubscriptionCard({
  sub,
  onForceRefresh,
  onRename,
  onRemove: _onRemove,
  forceRefreshing,
  forceRefreshError,
  removing: _removing,
  users,
}: SubscriptionCardProps) {
  // `onRemove` / `removing` retained on the prop interface so the caller
  // wiring stays intact for the day we gate delete by ownership/admin
  // role and re-enable the button. Underscore prefix marks intentional
  // disuse for now.
  void _onRemove
  void _removing
  const [renameOpen, setRenameOpen] = useState(false)
  const [labelDraft, setLabelDraft] = useState(sub.label ?? '')

  const handleRenameSubmit = () => {
    onRename({ email: sub.email, label: labelDraft.trim() })
    setRenameOpen(false)
  }

  // Mirror ReloginBadge's heuristic: the badge fires exactly when
  // `refreshExpiresAt <= now`. We re-derive here so the same boolean
  // gates both the at-a-glance badge in the header AND the actionable
  // explainer in the body. We don't pull the heuristic out into a
  // shared hook because the comparison is one line and a hook would
  // be more ceremony than it's worth — keeping it inline also makes
  // the test contract obvious.
  const reloginRequired = sub.refreshExpiresAt !== undefined && sub.refreshExpiresAt <= Date.now()

  return (
    <Card data-slot="subscription-card" className="flex flex-col">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="truncate text-base">{sub.label ?? sub.email}</CardTitle>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            {sub.label && <span className="truncate">{sub.email}</span>}
            {/*
             * No `slot` chip here. cvault is a shared vault: every user's
             * first sub stores slot=1 in their own keychain (per
             * convex/utils/users.ts), so a global `slot N` chip is
             * meaningless and confusing on the dashboard. The `slot`
             * field still ships in the payload — CLI 0.1.6 reads it for
             * `cvault list` rendering — only the visual chip is gone.
             */}
            <Badge variant="secondary">{sub.subscriptionType}</Badge>
          </div>
        </div>
        <ReloginBadge refreshExpiresAt={sub.refreshExpiresAt} />
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UsageBar label="5h" usage={sub.usage5h} idlePresentation="ready" />
          <UsageBar label="7d" usage={sub.usage7d} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <ExpiryCountdown expiresAt={sub.expiresAt} />
          <span className="text-muted-foreground">
            last refreshed <span className="tabular-nums">{formatRelativeAgo(sub.lastRefreshedAt)}</span>
          </span>
        </div>

        <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={forceRefreshing}
              onClick={() => {
                onForceRefresh({ email: sub.email })
              }}
            >
              {forceRefreshing ? 'Refreshing…' : 'Force Refresh'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setLabelDraft(sub.label ?? '')
                setRenameOpen(true)
              }}
            >
              Rename
            </Button>
            {/* Remove button intentionally hidden from the UI: shared-vault
                semantics let any authed user delete any sub, which is too
                destructive a footgun without an admin role. CLI `cvault
                remove` still works for the original adder. Re-enable here
                once admin/owner gating lands on the server. */}
          </div>
          {/* Who recently used this sub — overlapping avatars, click to drill in. */}
          <AvatarStack users={users} />
        </div>
        {forceRefreshError !== undefined && (
          <p data-slot="force-refresh-error" className="text-destructive text-xs" role="alert">
            {forceRefreshError}
          </p>
        )}
        {reloginRequired && (
          <div
            data-testid="relogin-explainer"
            role="alert"
            className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border p-3 text-xs"
          >
            <p className="font-medium">Token rotated externally.</p>
            <p className="mt-1 leading-relaxed">
              Run <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono">cvault add</code> on the
              machine where you most recently used{' '}
              <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono">claude</code> to recapture this
              subscription.
            </p>
          </div>
        )}
      </CardContent>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename subscription</DialogTitle>
            <DialogDescription>{sub.email}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-2">
            <Label htmlFor={`label-${sub._id}`}>Label</Label>
            <Input
              id={`label-${sub._id}`}
              value={labelDraft}
              onChange={(e) => {
                setLabelDraft(e.target.value)
              }}
              placeholder="e.g. Personal Max"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleRenameSubmit}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
