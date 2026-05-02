/**
 * `cvault list` — render every subscription in the vault.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Sources:
 *   - Convex `api.subscriptions.queries.listForUser` for sub metadata
 *     (no ciphertext, no plaintext — just slot, email, label, usage,
 *      expiry, last refresh)
 *   - Local `claude-swap --status` for the currently-active sub
 *
 * If `claude-swap --status` fails (binary missing, returns garbage), we
 * still render the table — just without an active marker.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { status } from '../claudeSwap'
import { makeVaultClient } from '../convex/vaultClient'
import { type SubRow, renderSubsTable } from '../render/table'

/**
 * Parse `claude-swap --status` output to find the active slot. Tolerant of
 * formatting drift; returns undefined if the format isn't recognized. See
 * `add.ts::parseActiveSlot` for the regex rationale (must accept the real
 * `Status: Account-N` format and reject the trailing `Total managed
 * accounts: N` summary line).
 */
function parseActiveSlot(out: string): number | undefined {
  const m = /Account[\s\-_:]+(\d+)/i.exec(out)
  if (!m || m[1] === undefined) return undefined
  const n = Number.parseInt(m[1], 10)
  return Number.isNaN(n) ? undefined : n
}

export async function runList(): Promise<void> {
  const client = await makeVaultClient()
  const subs = await client.query(api.subscriptions.queries.listForUser, {})

  let activeSlot: number | undefined
  try {
    activeSlot = parseActiveSlot(status())
  } catch {
    // claude-swap missing or errored — still render the rest of the table.
    activeSlot = undefined
  }

  const rows: SubRow[] = subs.map((s) => ({
    slot: s.slot,
    email: s.email,
    label: s.label,
    expiresAt: s.expiresAt,
    refreshExpiresAt: s.refreshExpiresAt,
    lastRefreshedAt: s.lastRefreshedAt,
    usage5hPct: s.usage5h?.pct,
    usage7dPct: s.usage7d?.pct,
    isActive: s.slot === activeSlot,
  }))

  console.log(renderSubsTable(rows))
}

export const listCommand = defineCommand({
  meta: { name: 'list', description: 'List all subscriptions in the vault.' },
  async run() {
    await runList()
  },
})
