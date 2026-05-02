/**
 * MachineRow — single row in /dashboard/machines.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * The Revoke button is wired by the parent page; this component is
 * presentational + stateless.
 */
import { Button } from '@/components/ui/button'

export type MachineRowProps = {
  clerkSessionId: string
  lastIpHash: string | undefined
  lastSeenAt: number
  onRevoke: (args: { sessionId: string }) => void
  pending: boolean
}

function relativeTime(at: number, now: number = Date.now()): string {
  const ms = now - at
  if (ms < 0) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes.toString()}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours.toString()}h ago`
  const days = Math.floor(hours / 24)
  return `${days.toString()}d ago`
}

export function MachineRow({
  clerkSessionId,
  lastIpHash,
  lastSeenAt,
  onRevoke,
  pending,
}: MachineRowProps) {
  return (
    <div
      data-slot="machine-row"
      className="border-border grid grid-cols-[1fr_140px_120px_120px] items-center gap-3 border-b px-4 py-3 text-sm"
    >
      <div className="font-mono text-xs">
        {clerkSessionId.slice(0, 14)}
        <span className="text-muted-foreground">…</span>
      </div>
      <div className="text-muted-foreground font-mono text-xs">{lastIpHash ?? '—'}</div>
      <div className="text-muted-foreground text-xs tabular-nums">{relativeTime(lastSeenAt)}</div>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={pending}
          onClick={() => {
            onRevoke({ sessionId: clerkSessionId })
          }}
        >
          {pending ? 'Revoking…' : 'Revoke'}
        </Button>
      </div>
    </div>
  )
}
