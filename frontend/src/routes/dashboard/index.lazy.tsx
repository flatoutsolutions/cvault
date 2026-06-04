/**
 * Lazy component for /dashboard — split out of `index.tsx` per
 * Track B item 9 (perf). TanStack Router code-splits each
 * `*.lazy.tsx` into its own chunk loaded on first navigation.
 *
 * Reads:
 *   - api.subscriptions.queries.listForUser          (live query)
 *   - api.subscriptions.assignments.listAssignments  (who's-using, live)
 * Writes:
 *   - Force Refresh → api.subscriptions.actions.requestRefresh
 *   - Rename        → api.subscriptions.mutations.rename
 *   - Remove        → api.subscriptions.mutations.softRemove
 *
 * The route is "thin" by design: SubscriptionCard owns the layout +
 * action-state plumbing; this file owns the Convex calls + per-card
 * pending-state map keyed by email.
 */
import { createLazyFileRoute } from '@tanstack/react-router'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useState } from 'react'

import { SubscriptionCard } from '@/components/dashboard/SubscriptionCard'
import { Skeleton } from '@/components/ui/skeleton'

import { api } from '../../../../convex/_generated/api'

export const Route = createLazyFileRoute('/dashboard/')({
  component: SubsPage,
})

/**
 * Exported for tests. Wired into TanStack Router via `Route` above.
 */
export function SubsPage() {
  const subs = useQuery(api.subscriptions.queries.listForUser, {})
  const assignments = useQuery(api.subscriptions.assignments.listAssignments, {})
  const rename = useMutation(api.subscriptions.mutations.rename)
  const softRemove = useMutation(api.subscriptions.mutations.softRemove)
  const requestRefresh = useAction(api.subscriptions.actions.requestRefresh)

  // Track which sub-emails currently have an in-flight action so we can
  // disable the matching button. We don't share this map with
  // SubscriptionCard via context — keeping it here makes the route file
  // the single owner of all mutation state.
  const [refreshingByEmail, setRefreshingByEmail] = useState<Record<string, boolean>>({})
  const [refreshErrorByEmail, setRefreshErrorByEmail] = useState<Record<string, string>>({})
  const [removingByEmail, setRemovingByEmail] = useState<Record<string, boolean>>({})

  // Loading state: useQuery returns undefined until the first response.
  if (subs === undefined) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-56 w-full rounded-xl" />
        ))}
      </div>
    )
  }

  if (subs.length === 0) {
    return <EmptyState />
  }

  // Index the who's-using data by subscription id so each card gets only its
  // own people. `assignments` is undefined until its query resolves; cards
  // render an empty stack until then and fill in reactively.
  const usersBySub = new Map((assignments ?? []).map((a) => [a.subscriptionId, a.users]))

  const handleForceRefresh = async ({ email }: { email: string }) => {
    const sub = subs.find((s) => s.email === email)
    if (!sub) {
      // Defensive: the live query is the source of truth for what's
      // visible; we shouldn't see a force-refresh for a sub that's not
      // in the rendered list. If it does happen, surface as an error.
      setRefreshErrorByEmail((prev) => ({
        ...prev,
        [email]: 'Subscription is no longer available — refresh the page.',
      }))
      return
    }
    setRefreshingByEmail((prev) => ({ ...prev, [email]: true }))
    setRefreshErrorByEmail((prev) => {
      const next = { ...prev }
      delete next[email]
      return next
    })
    try {
      await requestRefresh({ subId: sub._id })
      // The live `listForUser` query is reactive; the card will re-render
      // with the new lastRefreshedAt / expiresAt on its own.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[cvault] Force Refresh failed', err)
      setRefreshErrorByEmail((prev) => ({ ...prev, [email]: msg }))
    } finally {
      setRefreshingByEmail((prev) => {
        const next = { ...prev }
        delete next[email]
        return next
      })
    }
  }

  const handleRename = async ({ email, label }: { email: string; label: string }) => {
    await rename({ email, label })
  }

  const handleRemove = async ({ email }: { email: string }) => {
    setRemovingByEmail((prev) => ({ ...prev, [email]: true }))
    try {
      await softRemove({ email })
    } finally {
      setRemovingByEmail((prev) => {
        const next = { ...prev }
        delete next[email]
        return next
      })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Subscriptions</h1>
        <p className="text-muted-foreground text-sm">
          {subs.length.toString()} active {subs.length === 1 ? 'subscription' : 'subscriptions'} across all your
          machines.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {subs.map((sub) => (
          <SubscriptionCard
            key={sub._id}
            sub={sub}
            onForceRefresh={(args) => {
              void handleForceRefresh(args)
            }}
            onRename={(args) => {
              void handleRename(args)
            }}
            onRemove={(args) => {
              void handleRemove(args)
            }}
            forceRefreshing={refreshingByEmail[sub.email] === true}
            forceRefreshError={refreshErrorByEmail[sub.email]}
            removing={removingByEmail[sub.email] === true}
            users={usersBySub.get(sub._id) ?? []}
          />
        ))}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="bg-card border-border flex flex-col items-center gap-3 rounded-lg border p-12 text-center">
      <h1 className="text-xl font-semibold">No subscriptions yet</h1>
      <p className="text-muted-foreground max-w-md text-sm">
        Run <code className="bg-muted rounded px-1 py-0.5 font-mono">cvault add</code> on a machine that's already
        logged into Claude Code to import an Anthropic account into the vault.
      </p>
    </div>
  )
}
