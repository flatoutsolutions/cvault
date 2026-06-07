/**
 * Relative-time formatting, shared across the dashboard.
 *
 * Two intentionally-distinct shapes — `relativeTime` (coarse, single-unit) for
 * dense tables, `formatRelativeAgo` (compound) for the SubscriptionCard "last
 * refreshed" line. Previously copy-pasted into AuditRow / MachineRow / UsageBar;
 * consolidated here so the formats live in one place.
 */

/**
 * Coarse single-unit "time ago": "just now" / "5m ago" / "3h ago" / "2d ago".
 * Used where vertical density matters (audit feed, machines list).
 */
export function relativeTime(at: number, now: number = Date.now()): string {
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

/**
 * Compound "time ago": "just now" / "25m ago" / "3h 5m ago" / "2d 4h ago".
 * Used for the SubscriptionCard "last refreshed" line where the extra unit
 * reads better than plain minutes once a sub has been alive a while.
 */
export function formatRelativeAgo(at: number, now: number = Date.now()): string {
  const ms = now - at
  if (ms < 60_000) return 'just now'

  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60)
  const minutes = totalMinutes - days * 60 * 24 - hours * 60

  if (days > 0) return `${days.toString()}d ${hours.toString()}h ago`
  if (hours > 0) return `${hours.toString()}h ${minutes.toString()}m ago`
  return `${minutes.toString()}m ago`
}
