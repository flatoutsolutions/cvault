/**
 * AvatarStack — overlapping avatars of the people who recently used a
 * subscription, shown on the right of each SubscriptionCard footer (CVLT-1).
 *
 * Contract under test:
 * - Renders one avatar per user, up to `max` (default 4)
 * - Shows a "+N" overflow chip when there are more users than `max`
 * - Falls back to initials when a user has no imageUrl
 * - Renders a muted empty state when nobody is using the subscription
 * - Clicking the stack opens a popover listing every person (name, email,
 *   and their machine labels)
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Id } from '../../../../../convex/_generated/dataModel'
import { AvatarStack } from '../AvatarStack'
import type { SubscriptionUser } from '../AvatarStack'

function makeUser(overrides: Partial<SubscriptionUser> & { name: string; email: string }): SubscriptionUser {
  return {
    userId: overrides.email as unknown as Id<'users'>,
    name: overrides.name,
    email: overrides.email,
    machines: overrides.machines ?? [{ machineId: 'mac-1', label: 'Laptop', lastUsedAt: Date.now() - 60_000 }],
    lastUsedAt: overrides.lastUsedAt ?? Date.now() - 60_000,
    ...(overrides.imageUrl !== undefined ? { imageUrl: overrides.imageUrl } : {}),
  }
}

function avatars(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll('[data-slot="avatar"]')
}

describe('AvatarStack', () => {
  it('renders a muted empty state when there are no users', () => {
    const { container } = render(<AvatarStack users={[]} />)
    expect(screen.getByText(/no recent users/i)).toBeTruthy()
    expect(avatars(container)).toHaveLength(0)
  })

  it('renders one avatar per user when under the max', () => {
    const users = [
      makeUser({ name: 'Alice Tester', email: 'alice@x.com' }),
      makeUser({ name: 'Bob Tester', email: 'bob@x.com' }),
      makeUser({ name: 'Cara Tester', email: 'cara@x.com' }),
    ]
    const { container } = render(<AvatarStack users={users} />)
    expect(avatars(container)).toHaveLength(3)
    expect(screen.queryByText(/^\+\d+$/)).toBeNull()
  })

  it('caps visible avatars at max and shows a "+N" overflow chip', () => {
    const users = Array.from({ length: 6 }, (_, i) =>
      makeUser({ name: `User ${i.toString()}`, email: `u${i.toString()}@x.com` })
    )
    const { container } = render(<AvatarStack users={users} max={4} />)
    expect(avatars(container)).toHaveLength(4)
    expect(screen.getByText('+2')).toBeTruthy()
  })

  it('falls back to initials when a user has no imageUrl', () => {
    const users = [makeUser({ name: 'Alice Tester', email: 'alice@x.com' })]
    render(<AvatarStack users={users} />)
    expect(screen.getByText('AT')).toBeTruthy()
  })

  it('opens a popover listing every person with email and machine on click', () => {
    const users = [
      makeUser({
        name: 'Alice Tester',
        email: 'alice@x.com',
        machines: [{ machineId: 'mac-1', label: "Alice's MacBook", lastUsedAt: Date.now() - 60_000 }],
      }),
      makeUser({
        name: 'Bob Tester',
        email: 'bob@x.com',
        machines: [{ machineId: 'mac-2', label: 'bob-desktop', lastUsedAt: Date.now() - 60_000 }],
      }),
    ]
    render(<AvatarStack users={users} />)

    // Email + machine labels are not visible until the popover is opened.
    expect(screen.queryByText('alice@x.com')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /recently used/i }))

    expect(screen.getByText('alice@x.com')).toBeTruthy()
    expect(screen.getByText('bob@x.com')).toBeTruthy()
    expect(screen.getByText("Alice's MacBook")).toBeTruthy()
    expect(screen.getByText('bob-desktop')).toBeTruthy()
  })
})
