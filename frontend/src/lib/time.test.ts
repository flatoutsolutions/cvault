/**
 * Shared relative-time formatters. Two intentionally-distinct shapes:
 *   - relativeTime: coarse single-unit ("5m ago", "3h ago", "2d ago") for
 *     dense tables (audit feed, machines list)
 *   - formatRelativeAgo: compound ("3h 5m ago", "2d 4h ago") for the
 *     SubscriptionCard "last refreshed" line where precision reads better
 */
import { describe, expect, it } from 'vitest'

import { formatRelativeAgo, relativeTime } from './time'

const NOW = 1_000_000_000_000

describe('relativeTime', () => {
  it('returns "just now" for sub-minute and future timestamps', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now')
    expect(relativeTime(NOW - 30_000, NOW)).toBe('just now')
    expect(relativeTime(NOW + 5_000, NOW)).toBe('just now')
  })

  it('returns whole minutes under an hour', () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago')
  })

  it('returns whole hours under a day', () => {
    expect(relativeTime(NOW - 3 * 60 * 60_000, NOW)).toBe('3h ago')
  })

  it('returns whole days beyond a day', () => {
    expect(relativeTime(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2d ago')
  })
})

describe('formatRelativeAgo', () => {
  it('returns "just now" under a minute', () => {
    expect(formatRelativeAgo(NOW - 30_000, NOW)).toBe('just now')
  })

  it('returns plain minutes under an hour', () => {
    expect(formatRelativeAgo(NOW - 25 * 60_000, NOW)).toBe('25m ago')
  })

  it('returns compound hours+minutes under a day', () => {
    expect(formatRelativeAgo(NOW - (3 * 60 + 5) * 60_000, NOW)).toBe('3h 5m ago')
  })

  it('returns compound days+hours beyond a day', () => {
    expect(formatRelativeAgo(NOW - (2 * 24 + 4) * 60 * 60_000, NOW)).toBe('2d 4h ago')
  })
})
