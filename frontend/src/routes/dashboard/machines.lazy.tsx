/**
 * Lazy component for /dashboard/machines — split out per Track B item 9.
 *
 * Reads:  api.machineActivity.queries.distinctSessionsForUser
 * Writes: api.cli.actions.revokeSession
 *
 * The Revoke button calls the Convex action which proxies to Clerk
 * Backend API (`POST /v1/sessions/{id}/revoke`).
 */
import { createLazyFileRoute } from '@tanstack/react-router'
import { useAction, useQuery } from 'convex/react'
import { useState } from 'react'

import { MachineRow } from '@/components/dashboard/MachineRow'
import { Skeleton } from '@/components/ui/skeleton'

import { api } from '../../../../convex/_generated/api'

export const Route = createLazyFileRoute('/dashboard/machines')({
  component: MachinesPage,
})

/**
 * Composite-key delimiter for per-row state (pendingByRow, errorByRow)
 * AND for React's `key` prop. MUST match
 * `convex/machineActivity/queries.ts:SENTINEL_GROUP_DELIMITER` —
 * the query splits sentinel rows by `(sid, machineLabel)`, so the same
 * sid can appear on multiple rows. Keying state on sid alone would let a
 * spinner or inline error block bleed across rows. ASCII Unit Separator
 * (U+001F) cannot occur in a Clerk session id or in a user-supplied
 * `--label`, so the composite is collision-proof.
 *
 * Constructed via `String.fromCharCode` so this source file stays pure
 * ASCII — see the same docstring in `queries.ts` for the rationale.
 */
const ROW_KEY_DELIMITER = String.fromCharCode(0x1f)

function buildRowKey(args: { clerkSessionId: string; machineLabel: string | undefined }): string {
  return `${args.clerkSessionId}${ROW_KEY_DELIMITER}${args.machineLabel ?? ''}`
}

/**
 * Exported for tests.
 */
export function MachinesPage() {
  const sessions = useQuery(api.machineActivity.queries.distinctSessionsForUser, {})
  const revokeSession = useAction(api.cli.actions.revokeSession)

  // Per-row spinner / error state keyed by the composite rowKey, not by
  // sid alone — the new query splits sentinel rows by (sid, label) so the
  // same sid can appear on multiple rows. Keying by sid would let a
  // spinner/error block bleed across all sentinel rows.
  const [pendingByRow, setPendingByRow] = useState<Record<string, boolean>>({})
  // Index signature returns `string | undefined` so the `!== undefined` check
  // below is meaningful and not a tautology per noUncheckedIndexedAccess.
  const [errorByRow, setErrorByRow] = useState<Partial<Record<string, string>>>({})

  const handleRevoke = async ({ rowKey, sessionId }: { rowKey: string; sessionId: string }) => {
    setPendingByRow((prev) => ({ ...prev, [rowKey]: true }))
    setErrorByRow((prev) => {
      const next = { ...prev }
      delete next[rowKey]
      return next
    })
    try {
      await revokeSession({ clerkSessionId: sessionId })
    } catch (e) {
      setErrorByRow((prev) => ({
        ...prev,
        [rowKey]: e instanceof Error ? e.message : String(e),
      }))
    } finally {
      setPendingByRow((prev) => {
        const next = { ...prev }
        delete next[rowKey]
        return next
      })
    }
  }

  if (sessions === undefined) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Machines</h1>
        <p className="text-muted-foreground text-sm">
          Each row is a Clerk session that has called Convex from the cvault CLI. Revoke a session to immediately
          invalidate its credentials — the next CLI call from that machine will require{' '}
          <code className="bg-muted rounded px-1 py-0.5 font-mono">cvault login</code>.
        </p>
      </div>

      {sessions.length === 0 ? (
        <div className="bg-card border-border rounded-lg border p-8 text-center text-sm">
          <p className="text-muted-foreground">
            No machines have used the vault yet. Run{' '}
            <code className="bg-muted rounded px-1 py-0.5 font-mono">cvault login</code> on a machine to register it.
          </p>
        </div>
      ) : (
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <div className="border-border text-muted-foreground grid grid-cols-[1fr_auto] gap-3 border-b px-4 py-2 text-xs font-medium uppercase tracking-wide">
            <div>machine</div>
            <div className="text-right">action</div>
          </div>
          {sessions.map((s) => {
            const rowKey = buildRowKey({ clerkSessionId: s.clerkSessionId, machineLabel: s.machineLabel })
            return (
              <div key={rowKey} className="flex flex-col">
                <MachineRow
                  clerkSessionId={s.clerkSessionId}
                  lastIpHash={s.lastIpHash}
                  lastSeenAt={s.lastSeenAt}
                  machineLabel={s.machineLabel}
                  revocable={s.revocable}
                  onRevoke={(args) => {
                    void handleRevoke({ rowKey, sessionId: args.sessionId })
                  }}
                  pending={pendingByRow[rowKey] === true}
                />
                {errorByRow[rowKey] !== undefined ? (
                  <div className="bg-destructive/10 text-destructive border-border border-b px-4 py-2 text-xs">
                    {errorByRow[rowKey]}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
