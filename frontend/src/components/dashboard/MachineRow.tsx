/**
 * MachineRow — single row in /dashboard/machines.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Visual hierarchy:
 *   ┌─────────────────────────────────────────┬──────────┐
 *   │ <machineLabel>                          │ [Revoke] │
 *   │ Last seen 23m ago · IP: a1b2c3d4        │          │
 *   └─────────────────────────────────────────┴──────────┘
 *
 * The opaque `machineId` is exposed via the row's native `title` attribute
 * so a maintainer can hover for debugging without cluttering the user-facing UI.
 *
 * When `revokedAt` is set the row renders a muted "revoked" badge and the
 * Revoke button is disabled (already revoked).
 *
 * The component is presentational + stateless; the parent page wires
 * `onRevoke` to `api.cli.actions.revokeDevice`.
 */
import { Button } from '@/components/ui/button'

export type MachineRowProps = {
  machineId: string
  lastIpHash: string | undefined
  lastSeenAt: number
  /**
   * Human-readable identifier for the machine (defaults to hostname,
   * overridable via `cvault login --label`). Optional because legacy
   * pre-feature rows don't carry one — the row falls back to a
   * "(no label)" placeholder.
   */
  machineLabel: string | undefined
  /**
   * Unix timestamp (ms) at which this machine was revoked. When set the
   * Revoke button is disabled and a muted "revoked" indicator is shown.
   */
  revokedAt: number | undefined
  onRevoke: (args: { machineId: string }) => void
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
  machineId,
  lastIpHash,
  lastSeenAt,
  machineLabel,
  revokedAt,
  onRevoke,
  pending,
}: MachineRowProps) {
  const isRevoked = revokedAt !== undefined
  const lastSeenText = `Last seen ${relativeTime(lastSeenAt)}`
  const ipText = lastIpHash !== undefined ? `IP: ${lastIpHash}` : undefined

  // Primary label: show the machine label if set; otherwise "(no label)".
  const primary: { text: string; className: string } =
    machineLabel !== undefined
      ? { text: machineLabel, className: 'text-foreground truncate font-medium' }
      : { text: '(no label)', className: 'text-muted-foreground italic' }

  return (
    <div
      data-slot="machine-row"
      className="border-border grid grid-cols-[1fr_auto] items-center gap-3 border-b px-4 py-3 text-sm"
      title={machineId}
    >
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-2">
          <span className={primary.className}>{primary.text}</span>
          {isRevoked ? (
            <span className="text-muted-foreground rounded bg-muted px-1.5 py-0.5 text-xs italic">revoked</span>
          ) : null}
        </div>
        <span className="text-muted-foreground text-xs tabular-nums">
          {lastSeenText}
          {ipText !== undefined ? (
            <>
              {' · '}
              <span className="font-mono">{ipText}</span>
            </>
          ) : null}
        </span>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={pending || isRevoked}
          onClick={() => {
            onRevoke({ machineId })
          }}
        >
          {pending ? 'Revoking…' : 'Revoke'}
        </Button>
      </div>
    </div>
  )
}
