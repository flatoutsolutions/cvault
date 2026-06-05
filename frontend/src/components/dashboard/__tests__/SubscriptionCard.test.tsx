/**
 * SubscriptionCard — primary card on /dashboard, one per active sub.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Composes UsageBar, ExpiryCountdown, and ReloginBadge, and exposes
 * three per-card actions:
 *   - Force Refresh  → calls onForceRefresh({email})
 *   - Rename         → calls onRename({email, label})
 *   - Remove         → calls onRemove({email})
 *
 * The card is presentational: the route owns the Convex calls and just
 * passes callbacks down so the component is easy to test.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { SubscriptionUser } from '../AvatarStack'
import type { SubscriptionMeta } from '../SubscriptionCard'
import { SubscriptionCard } from '../SubscriptionCard'

function makeUser(name: string, email: string): SubscriptionUser {
  return {
    userId: email as unknown as SubscriptionUser['userId'],
    name,
    email,
    machines: [{ machineId: 'mac-1', label: 'Laptop', lastUsedAt: Date.now() - 60_000 }],
    lastUsedAt: Date.now() - 60_000,
  }
}

function makeSub(overrides: Partial<SubscriptionMeta> = {}): SubscriptionMeta {
  const now = Date.now()
  return {
    _id: 'sub_1' as SubscriptionMeta['_id'],
    _creationTime: now - 60_000,
    userId: 'user_1' as SubscriptionMeta['userId'],
    email: 'alice@example.com',
    slot: 1,
    label: undefined,
    expiresAt: now + 60 * 60 * 1000,
    refreshExpiresAt: undefined,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
    lastRefreshedAt: now - 30 * 60_000,
    refreshLeaseHolder: undefined,
    refreshLeaseUntil: undefined,
    usage5h: { pct: 42, resetsAt: now + 60 * 60 * 1000, fetchedAt: now },
    usage7d: { pct: 71, resetsAt: now + 6 * 24 * 60 * 60 * 1000, fetchedAt: now },
    removedAt: undefined,
    ...overrides,
  }
}

describe('SubscriptionCard', () => {
  it('renders the email and subscription type without a slot chip (shared vault — slot is per-user, meaningless globally)', () => {
    // cvault is a shared vault: every authenticated user's first sub has
    // slot=1 in their own keychain, so two users' cards both labelled
    // "slot 1" on the dashboard is confusing. Slot is a CLI-local
    // concept — the web dashboard identifies subs by email instead.
    // The `slot` field still ships in the payload (CLI 0.1.6 reads it
    // for `cvault list`); only the visual chip is gone.
    render(
      <SubscriptionCard
        sub={makeSub({ email: 'alice@example.com', slot: 3, subscriptionType: 'max' })}
        onForceRefresh={vi.fn()}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        forceRefreshing={false}
        removing={false}
        users={[]}
      />
    )
    expect(screen.getByText('alice@example.com')).toBeTruthy()
    expect(screen.queryByText(/slot/i)).toBeNull()
    expect(screen.getByText(/max/i)).toBeTruthy()
  })

  it('renders the user-supplied label when present', () => {
    render(
      <SubscriptionCard
        sub={makeSub({ label: 'Personal Max' })}
        onForceRefresh={vi.fn()}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        forceRefreshing={false}
        removing={false}
        users={[]}
      />
    )
    expect(screen.getByText('Personal Max')).toBeTruthy()
  })

  it('renders both usage bars (5h, 7d) using the inline usage data', () => {
    const now = Date.now()
    const { container } = render(
      <SubscriptionCard
        sub={makeSub({
          usage5h: { pct: 42, resetsAt: now + 60 * 60 * 1000, fetchedAt: now },
          usage7d: { pct: 71, resetsAt: now + 6 * 24 * 60 * 60 * 1000, fetchedAt: now },
        })}
        onForceRefresh={vi.fn()}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        forceRefreshing={false}
        removing={false}
        users={[]}
      />
    )
    const bars = container.querySelectorAll('[data-slot="usage-bar"]')
    expect(bars).toHaveLength(2)
    expect(screen.getByText('42%')).toBeTruthy()
    expect(screen.getByText('71%')).toBeTruthy()
  })

  it('renders the relogin badge when refreshExpiresAt is past', () => {
    render(
      <SubscriptionCard
        sub={makeSub({ refreshExpiresAt: Date.now() - 1000 })}
        onForceRefresh={vi.fn()}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        forceRefreshing={false}
        removing={false}
        users={[]}
      />
    )
    expect(screen.getByText(/relogin required/i)).toBeTruthy()
  })

  it('renders an explanatory block with the cvault add remediation when refreshExpiresAt is past', () => {
    // The badge alone is the at-a-glance signal; the body block is
    // the actionable hint that tells the user WHAT to do. Spec/brief
    // wording requirement: must mention `cvault add` and explain that
    // the token rotated externally.
    render(
      <SubscriptionCard
        sub={makeSub({ refreshExpiresAt: Date.now() - 1000 })}
        onForceRefresh={vi.fn()}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        forceRefreshing={false}
        removing={false}
        users={[]}
      />
    )
    const explainer = screen.getByTestId('relogin-explainer')
    const text = explainer.textContent
    expect(text).toMatch(/cvault add/i)
    expect(text.toLowerCase()).toMatch(/rotated|recapture|re-?capture/)
  })

  it('does NOT render the relogin explainer when refreshExpiresAt is unset', () => {
    render(
      <SubscriptionCard
        sub={makeSub({ refreshExpiresAt: undefined })}
        onForceRefresh={vi.fn()}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        forceRefreshing={false}
        removing={false}
        users={[]}
      />
    )
    expect(screen.queryByTestId('relogin-explainer')).toBeNull()
  })

  it('calls onForceRefresh with the sub email when Force Refresh is clicked', () => {
    const onForceRefresh = vi.fn()
    render(
      <SubscriptionCard
        sub={makeSub({ email: 'alice@example.com' })}
        onForceRefresh={onForceRefresh}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        forceRefreshing={false}
        removing={false}
        users={[]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /force refresh/i }))
    expect(onForceRefresh).toHaveBeenCalledWith({ email: 'alice@example.com' })
  })

  it('disables the Force Refresh button while forceRefreshing is true', () => {
    render(
      <SubscriptionCard
        sub={makeSub()}
        onForceRefresh={vi.fn()}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        forceRefreshing={true}
        removing={false}
        users={[]}
      />
    )
    const btn = screen.getByRole('button', { name: /refreshing/i })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not render a Remove button (hidden until admin/owner gating lands)', () => {
    const onRemove = vi.fn()
    render(
      <SubscriptionCard
        sub={makeSub({ email: 'alice@example.com' })}
        onForceRefresh={vi.fn()}
        onRename={vi.fn()}
        onRemove={onRemove}
        forceRefreshing={false}
        removing={false}
        users={[]}
      />
    )
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull()
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('renders the AvatarStack empty state alongside the actions when no one is using the sub', () => {
    render(
      <SubscriptionCard
        sub={makeSub()}
        onForceRefresh={vi.fn()}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        forceRefreshing={false}
        removing={false}
        users={[]}
      />
    )
    expect(screen.getByText(/nobody has used/i)).toBeTruthy()
    // The footer actions stay put on the left.
    expect(screen.getByRole('button', { name: /force refresh/i })).toBeTruthy()
  })

  it('renders an avatar for each person currently using the sub', () => {
    render(
      <SubscriptionCard
        sub={makeSub()}
        onForceRefresh={vi.fn()}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        forceRefreshing={false}
        removing={false}
        users={[makeUser('Alice Tester', 'alice@example.com')]}
      />
    )
    // Initials fallback proves the AvatarStack rendered the person.
    expect(screen.getByText('AT')).toBeTruthy()
    expect(screen.getByRole('button', { name: /recently used/i })).toBeTruthy()
  })

  it('opens the rename dialog when Rename is clicked and submits the new label', () => {
    const onRename = vi.fn()
    render(
      <SubscriptionCard
        sub={makeSub({ email: 'alice@example.com', label: 'Old' })}
        onForceRefresh={vi.fn()}
        onRename={onRename}
        onRemove={vi.fn()}
        forceRefreshing={false}
        removing={false}
        users={[]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /rename/i }))
    // The dialog input is rendered with the existing label as default
    const input = screen.getByLabelText(/label/i)
    fireEvent.change(input, { target: { value: 'Work Max' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onRename).toHaveBeenCalledWith({ email: 'alice@example.com', label: 'Work Max' })
  })
})
