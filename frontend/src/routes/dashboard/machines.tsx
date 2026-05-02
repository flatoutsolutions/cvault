/**
 * /dashboard/machines — list of Clerk sessions that have used the vault.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Reads:  api.machineActivity.queries.distinctSessionsForUser
 * Writes: api.cli.actions.revokeSession
 *
 * The Revoke button calls the Convex action which proxies to Clerk
 * Backend API (`POST /v1/sessions/{id}/revoke`).
 */
import { useAction, useQuery } from 'convex/react'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { MachineRow } from '@/components/dashboard/MachineRow'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '../../../../convex/_generated/api'

export const Route = createFileRoute('/dashboard/machines')({
  component: MachinesPage,
})

/**
 * Exported for tests.
 */
export function MachinesPage() {
  const sessions = useQuery(api.machineActivity.queries.distinctSessionsForUser, {})
  const revokeSession = useAction(api.cli.actions.revokeSession)

  const [pendingByEmail, setPendingByEmail] = useState<Record<string, boolean>>({})
  // Index signature returns `string | undefined` so the `!== undefined` check
  // below is meaningful and not a tautology per noUncheckedIndexedAccess.
  const [errorByEmail, setErrorByEmail] = useState<Partial<Record<string, string>>>({})

  const handleRevoke = async ({ sessionId }: { sessionId: string }) => {
    setPendingByEmail((prev) => ({ ...prev, [sessionId]: true }))
    setErrorByEmail((prev) => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    try {
      await revokeSession({ clerkSessionId: sessionId })
    } catch (e) {
      setErrorByEmail((prev) => ({
        ...prev,
        [sessionId]: e instanceof Error ? e.message : String(e),
      }))
    } finally {
      setPendingByEmail((prev) => {
        const next = { ...prev }
        delete next[sessionId]
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
          Each row is a Clerk session that has called Convex from the cvault CLI.
          Revoke a session to immediately invalidate its credentials — the next
          CLI call from that machine will require <code className="bg-muted rounded px-1 py-0.5 font-mono">cvault login</code>.
        </p>
      </div>

      {sessions.length === 0 ? (
        <div className="bg-card border-border rounded-lg border p-8 text-center text-sm">
          <p className="text-muted-foreground">
            No machines have used the vault yet. Run{' '}
            <code className="bg-muted rounded px-1 py-0.5 font-mono">cvault login</code> on a
            machine to register it.
          </p>
        </div>
      ) : (
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <div className="border-border text-muted-foreground grid grid-cols-[1fr_140px_120px_120px] gap-3 border-b px-4 py-2 text-xs font-medium uppercase tracking-wide">
            <div>session</div>
            <div>last ip</div>
            <div>last seen</div>
            <div className="text-right">action</div>
          </div>
          {sessions.map((s) => (
            <div key={s.clerkSessionId} className="flex flex-col">
              <MachineRow
                clerkSessionId={s.clerkSessionId}
                lastIpHash={s.lastIpHash}
                lastSeenAt={s.lastSeenAt}
                onRevoke={(args) => {
                  void handleRevoke(args)
                }}
                pending={pendingByEmail[s.clerkSessionId] === true}
              />
              {errorByEmail[s.clerkSessionId] !== undefined ? (
                <div className="bg-destructive/10 text-destructive border-border border-b px-4 py-2 text-xs">
                  {errorByEmail[s.clerkSessionId]}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
