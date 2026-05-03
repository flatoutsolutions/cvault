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

import type { api } from '../../../../convex/_generated/api'
import { ExpiryCountdown } from './ExpiryCountdown'
import { ReloginBadge } from './ReloginBadge'
import { UsageBar, formatRelativeAgo } from './UsageBar'

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
}

export function SubscriptionCard({
  sub,
  onForceRefresh,
  onRename,
  onRemove,
  forceRefreshing,
  forceRefreshError,
  removing,
}: SubscriptionCardProps) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [labelDraft, setLabelDraft] = useState(sub.label ?? '')

  const handleRenameSubmit = () => {
    onRename({ email: sub.email, label: labelDraft.trim() })
    setRenameOpen(false)
  }

  return (
    <Card data-slot="subscription-card" className="flex flex-col">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="truncate text-base">{sub.label ?? sub.email}</CardTitle>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            {sub.label && <span className="truncate">{sub.email}</span>}
            <Badge variant="outline" className="font-mono">
              slot {sub.slot}
            </Badge>
            <Badge variant="secondary">{sub.subscriptionType}</Badge>
          </div>
        </div>
        <ReloginBadge refreshExpiresAt={sub.refreshExpiresAt} />
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UsageBar label="5h" usage={sub.usage5h} />
          <UsageBar label="7d" usage={sub.usage7d} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <ExpiryCountdown expiresAt={sub.expiresAt} />
          <span className="text-muted-foreground">
            last refreshed <span className="tabular-nums">{formatRelativeAgo(sub.lastRefreshedAt)}</span>
          </span>
        </div>

        <div className="border-border flex flex-wrap items-center gap-2 border-t pt-4">
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={removing}
            onClick={() => {
              onRemove({ email: sub.email })
            }}
            className="text-destructive hover:text-destructive ml-auto"
          >
            {removing ? 'Removing…' : 'Remove'}
          </Button>
        </div>
        {forceRefreshError !== undefined && (
          <p data-slot="force-refresh-error" className="text-destructive text-xs" role="alert">
            {forceRefreshError}
          </p>
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
