/**
 * Plain-text table renderer for `cvault list`.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Columns: rank (#), email, label, 5h%, 7d%, expires (relative), last
 * refresh (relative), stored, status. Designed to be readable in a
 * 100-col terminal without external deps (no chalk, no cli-table —
 * keeps the binary lean).
 *
 * Why `#` (rank) instead of the stored `slot` field:
 *   The shared vault assigns slots per-user, so two different users'
 *   first subs both have `slot=1`. Rendering the stored slot produced
 *   two `1`s in the table — useless for `cvault switch <N>`. The CLI
 *   now renders the FCFS rank (server returns rows ordered by
 *   `_creationTime` ASC, see `convex/subscriptions/queries.ts:list`),
 *   which `cvault switch <N>` already interprets as the ordinal it
 *   should resolve to. End-to-end consistent.
 */

export interface SubRow {
  /** 1-indexed FCFS rank — the integer the user passes to `cvault switch <N>`. */
  rank: number
  email: string
  label?: string | undefined
  /** Access-token expiry in ms epoch. */
  expiresAt: number
  /** Last refresh timestamp in ms epoch. */
  lastRefreshedAt: number
  /** Refresh-token expiry in ms epoch. If <= now, surface "relogin" badge. */
  refreshExpiresAt?: number | undefined
  /** 5-hour usage percentage (0-100). Undefined when idle or not yet polled. */
  usage5hPct?: number | undefined
  /**
   * True when a successful poll found no active 5h window (it has reset; a
   * fresh one starts on next use). Rendered as `ready` instead of a percent.
   */
  usage5hIdle?: boolean | undefined
  /** 7-day usage percentage (0-100). */
  usage7dPct?: number | undefined
  /** True if this sub is the currently-active local Keychain entry. */
  isActive: boolean
}

// STORED tells the user where each credential lives. Every row in the
// list IS by definition in the cloud vault (that's what the query
// returns), so the column reflects whether a copy ALSO exists locally:
//   - `local+cloud` → vault row + active local Keychain entry. Native is
//                     single-slot so at most one row gets this label.
//   - `cloud`       → vault-only on this machine. `cvault switch <N>`
//                     will pull + import it.
const HEADERS = ['#', 'EMAIL', 'LABEL', '5H', '7D', 'EXPIRES', 'LAST REFRESH', 'STORED', 'STATUS'] as const

/**
 * Format a future or past timestamp relative to `now` ms.
 * Returns `now`, `in Xs/m/h/d`, or `Xs/m/h/d ago`.
 */
export function formatRelativeMs(target: number, now: number): string {
  const diff = target - now
  if (diff === 0) return 'now'
  const abs = Math.abs(diff)
  const units: Array<[number, string]> = [
    [24 * 60 * 60 * 1000, 'd'],
    [60 * 60 * 1000, 'h'],
    [60 * 1000, 'm'],
    [1000, 's'],
  ]
  let value = 0
  let unit = 's'
  for (const [ms, label] of units) {
    if (abs >= ms) {
      value = Math.floor(abs / ms)
      unit = label
      break
    }
  }
  if (value === 0) {
    value = Math.floor(abs / 1000)
    unit = 's'
  }
  return diff > 0 ? `in ${String(value)}${unit}` : `${String(value)}${unit} ago`
}

function pct(n: number | undefined): string {
  if (n === undefined) return '-'
  return `${String(Math.round(n))}%`
}

/** Pad a string to `width` chars on the right. */
function padRight(s: string, width: number): string {
  if (s.length >= width) return s
  return s + ' '.repeat(width - s.length)
}

export function renderSubsTable(rows: SubRow[], now: number = Date.now()): string {
  if (rows.length === 0) {
    return 'No subscriptions yet. Run `cvault add` to capture your first Claude Code login.'
  }

  // Build cells per row. Active marker prefixes the rank (#) column.
  const dataRows: string[][] = rows.map((r) => {
    const rankCell = `${r.isActive ? '*' : ' '} ${String(r.rank)}`
    const reloginRequired = r.refreshExpiresAt !== undefined && r.refreshExpiresAt <= now
    const statusCell = reloginRequired ? '⚠ relogin' : 'ok'
    const storedCell = r.isActive ? 'local+cloud' : 'cloud'
    // 5h renders `ready` when the window has reset (idle) — a fresh window
    // starts on next use. 7d stays a bare percent/`-`: an absent 7d window is
    // ambiguous (a Pro account has no weekly window), so we don't claim ready.
    const usage5hCell = r.usage5hIdle === true ? 'ready' : pct(r.usage5hPct)
    return [
      rankCell,
      r.email,
      r.label ?? '',
      usage5hCell,
      pct(r.usage7dPct),
      formatRelativeMs(r.expiresAt, now),
      formatRelativeMs(r.lastRefreshedAt, now),
      storedCell,
      statusCell,
    ]
  })

  // Compute column widths from headers + data.
  const widths: number[] = HEADERS.map((h, i) => {
    let w = h.length
    for (const row of dataRows) {
      const cell = row[i] ?? ''
      if (cell.length > w) w = cell.length
    }
    return w
  })

  const headerLine = HEADERS.map((h, i) => padRight(h, widths[i] ?? h.length)).join('  ')
  const sep = widths.map((w) => '-'.repeat(w)).join('  ')
  const dataLines = dataRows.map((row) => row.map((cell, i) => padRight(cell, widths[i] ?? cell.length)).join('  '))

  return [headerLine, sep, ...dataLines].join('\n')
}
