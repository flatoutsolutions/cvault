/**
 * AvatarStack — the "who is using this subscription" affordance on each
 * SubscriptionCard footer (CVLT-1).
 *
 * Renders an overlapping stack of round avatars for the people who most
 * recently used a subscription, with a "+N" overflow chip past `max`. Clicking
 * the stack opens a popover that lists every person, their email, and the
 * machine(s) they used it on.
 *
 * "Most recently used", not "currently using": attribution is each machine's
 * latest activation with no recency window, so a long-idle machine still
 * appears until it's revoked. The copy below says "recently used" to match.
 *
 * Type contract: `SubscriptionUser` is derived from the
 * `api.subscriptions.assignments.listAssignments` return so this component
 * stays in lockstep with the backend validator — no hand-maintained shape.
 */
import type { FunctionReturnType } from 'convex/server'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

import type { api } from '../../../../convex/_generated/api'
import { formatRelativeAgo } from './UsageBar'

/** One person on a subscription, as returned by `listAssignments`. */
export type SubscriptionUser = FunctionReturnType<
  typeof api.subscriptions.assignments.listAssignments
>[number]['users'][number]

export type AvatarStackProps = {
  users: SubscriptionUser[]
  /** Maximum number of avatars shown before collapsing into a "+N" chip. */
  max?: number
}

/** Up to two initials from a display name, e.g. "Alice Tester" → "AT". */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const letters = parts.slice(0, 2).map((p) => p.charAt(0))
  return letters.join('').toUpperCase()
}

function UserAvatar({ user, className }: { user: SubscriptionUser; className?: string }) {
  return (
    <Avatar className={className} title={user.name}>
      {user.imageUrl !== undefined ? <AvatarImage src={user.imageUrl} alt={user.name} /> : null}
      <AvatarFallback>{initialsOf(user.name)}</AvatarFallback>
    </Avatar>
  )
}

export function AvatarStack({ users, max = 4 }: AvatarStackProps) {
  if (users.length === 0) {
    return (
      <span data-slot="avatar-stack-empty" className="text-muted-foreground text-xs italic">
        No recent users
      </span>
    )
  }

  const visible = users.slice(0, max)
  const overflow = users.length - visible.length

  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label={`Show who recently used this subscription (${users.length.toString()})`}
        className="flex items-center -space-x-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {visible.map((user) => (
          <UserAvatar key={user.userId} user={user} className="ring-2 ring-card" />
        ))}
        {overflow > 0 ? (
          <span
            data-slot="avatar-overflow"
            className="bg-muted text-muted-foreground ring-card relative flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium ring-2"
          >
            +{overflow.toString()}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-border border-b px-4 py-3">
          <p className="text-sm font-medium">Recently used by</p>
          <p className="text-muted-foreground text-xs">
            {users.length.toString()} {users.length === 1 ? 'person' : 'people'}
          </p>
        </div>
        <ul className="flex max-h-72 flex-col overflow-y-auto py-1">
          {users.map((user) => (
            <li key={user.userId} className="flex items-start gap-3 px-4 py-2">
              <UserAvatar user={user} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{user.name}</span>
                <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                <div className="mt-1 flex flex-col gap-0.5">
                  {user.machines.map((m) => (
                    <span key={m.machineId} className="text-muted-foreground text-xs" title={m.machineId}>
                      <span className="text-foreground">{m.label ?? '(no label)'}</span>
                      {' · '}
                      <span className="tabular-nums">{formatRelativeAgo(m.lastUsedAt)}</span>
                    </span>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
