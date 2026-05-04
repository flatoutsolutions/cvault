/**
 * MachineRow — single row in /dashboard/machines.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Visual hierarchy (after the machineLabel rollout):
 *   ┌─────────────────────────────────────────┬──────────┐
 *   │ <machineLabel>                          │ [Revoke] │
 *   │ Last seen 23m ago · IP: a1b2c3d4        │          │
 *   └─────────────────────────────────────────┴──────────┘
 *
 * The opaque `clerkSessionId` is no longer visible — it's exposed via the
 * row's native `title` attribute so a maintainer can hover for debugging
 * without cluttering the user-facing UI. Revoke is still keyed by
 * `clerkSessionId` because the backend's Clerk Backend API call needs it.
 *
 * The component is presentational + stateless; the parent page wires
 * `onRevoke` to `api.cli.actions.revokeSession`.
 */
import { Button } from '@/components/ui/button'

export type MachineRowProps = {
  clerkSessionId: string
  lastIpHash: string | undefined
  lastSeenAt: number
  /**
   * Human-readable identifier for the machine (defaults to hostname,
   * overridable via `cvault login --label`). Optional because legacy
   * pre-feature rows don't carry one — the row falls back to a
   * "(no label)" placeholder rather than exposing the opaque sessionId
   * to the end user.
   */
  machineLabel: string | undefined
  /**
   * Whether the row maps to a real Clerk session. False for the
   * `unknown-session` sentinel — Revoke is disabled because there's no
   * BAPI-revocable session, but the row still renders so the user
   * sees the activity (cron, server-context writes, pre-fix CLI).
   */
  revocable: boolean
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
  machineLabel,
  revocable,
  onRevoke,
  pending,
}: MachineRowProps) {
  const lastSeenText = `Last seen ${relativeTime(lastSeenAt)}`
  const ipText = lastIpHash !== undefined ? `IP: ${lastIpHash}` : undefined
  const revokeDisabledTitle = revocable
    ? undefined
    : 'No live Clerk session — this row was written by a cron job or a CLI version that pre-dates the explicit session-id arg. Re-login from the affected machine to register a revocable session.'

  // Primary label rules (in priority order):
  //  - non-revocable + no label → "Server-side activity" so users can
  //    distinguish "real machine that pre-dates the label feature" from
  //    "non-revocable server-side row" (cron, server context, pre-fix CLI).
  //    Regular weight + foreground color; "server-side" hint moves to the
  //    secondary line.
  //  - revocable + label → user-visible label, prominent.
  //  - revocable + no label → italic "(no label)" placeholder so we never
  //    expose the opaque sessionId as the primary identifier.
  let primary: { text: string; className: string }
  if (!revocable && machineLabel === undefined) {
    primary = { text: 'Server-side activity', className: 'text-foreground truncate' }
  } else if (machineLabel !== undefined) {
    primary = { text: machineLabel, className: 'text-foreground truncate font-medium' }
  } else {
    primary = { text: '(no label)', className: 'text-muted-foreground italic' }
  }

  return (
    <div
      data-slot="machine-row"
      className="border-border grid grid-cols-[1fr_auto] items-center gap-3 border-b px-4 py-3 text-sm"
      title={clerkSessionId}
    >
      <div className="flex min-w-0 flex-col">
        <span className={primary.className}>{primary.text}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {lastSeenText}
          {ipText !== undefined ? (
            <>
              {' · '}
              <span className="font-mono">{ipText}</span>
            </>
          ) : null}
          {!revocable ? (
            <>
              {' · '}
              <span className="italic">server-side</span>
            </>
          ) : null}
        </span>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={pending || !revocable}
          title={revokeDisabledTitle}
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
