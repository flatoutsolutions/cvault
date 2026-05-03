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

import type { SubscriptionMeta } from '../SubscriptionCard'
import { SubscriptionCard } from '../SubscriptionCard'

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
  it('renders the email, slot, and subscription type', () => {
    render(
      <SubscriptionCard
        sub={makeSub({ email: 'alice@example.com', slot: 3, subscriptionType: 'max' })}
        onForceRefresh={vi.fn()}
        onRename={vi.fn()}
        onRemove={vi.fn()}
        forceRefreshing={false}
        removing={false}
      />
    )
    expect(screen.getByText('alice@example.com')).toBeTruthy()
    expect(screen.getByText(/slot 3/i)).toBeTruthy()
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
      />
    )
    const btn = screen.getByRole('button', { name: /refreshing/i })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it('calls onRemove with the sub email when Remove is clicked', () => {
    const onRemove = vi.fn()
    render(
      <SubscriptionCard
        sub={makeSub({ email: 'alice@example.com' })}
        onForceRefresh={vi.fn()}
        onRename={vi.fn()}
        onRemove={onRemove}
        forceRefreshing={false}
        removing={false}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    expect(onRemove).toHaveBeenCalledWith({ email: 'alice@example.com' })
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
