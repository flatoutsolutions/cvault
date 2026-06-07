/**
 * Lazy component for /dashboard/machines — split out per Track B item 9.
 *
 * Reads:  api.devices.queries.listForUser
 * Writes: api.cli.actions.revokeDevice
 *
 * The Revoke button calls the Convex action which marks the device revoked
 * and revokes the underlying Clerk OAuth grant. A row with `revokedAt` set
 * renders a "revoked" badge and has its Revoke button disabled.
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
 * Exported for tests.
 */
export function MachinesPage() {
  const devices = useQuery(api.devices.queries.listForUser, {})
  const revokeDevice = useAction(api.cli.actions.revokeDevice)

  // Per-row spinner / error state keyed by machineId.
  const [pendingByRow, setPendingByRow] = useState<Record<string, boolean>>({})
  const [errorByRow, setErrorByRow] = useState<Partial<Record<string, string>>>({})

  const handleRevoke = async ({ machineId }: { machineId: string }) => {
    setPendingByRow((prev) => ({ ...prev, [machineId]: true }))
    setErrorByRow((prev) => {
      const next = { ...prev }
      delete next[machineId]
      return next
    })
    try {
      await revokeDevice({ machineId })
    } catch (e) {
      setErrorByRow((prev) => ({
        ...prev,
        [machineId]: e instanceof Error ? e.message : String(e),
      }))
    } finally {
      setPendingByRow((prev) => {
        const next = { ...prev }
        delete next[machineId]
        return next
      })
    }
  }

  if (devices === undefined) {
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
          Each row is a registered machine that has used the cvault CLI. Revoke a machine to sign it out — it must run{' '}
          <code className="bg-muted rounded px-1 py-0.5 font-mono">cvault login</code> again. Takes effect on the
          machine&apos;s next request.
        </p>
      </div>

      {devices.length === 0 ? (
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
          {devices.map((d) => (
            <div key={d.machineId} className="flex flex-col">
              <MachineRow
                machineId={d.machineId}
                lastIpHash={d.lastIpHash}
                lastSeenAt={d.lastSeenAt}
                machineLabel={d.label}
                revokedAt={d.revokedAt}
                onRevoke={(args) => {
                  void handleRevoke({ machineId: args.machineId })
                }}
                pending={pendingByRow[d.machineId] === true}
              />
              {errorByRow[d.machineId] !== undefined ? (
                <div className="bg-destructive/10 text-destructive border-border border-b px-4 py-2 text-xs">
                  {errorByRow[d.machineId]}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
