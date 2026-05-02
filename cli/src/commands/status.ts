/**
 * `cvault status` — show the currently-active sub with server-side meta.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Combines:
 *   - Native `getActiveAccount()` (from `credentials.ts`) → active email
 *     (read from the local credentials store + `~/.claude.json`)
 *   - `api.subscriptions.queries.getMetaByEmail` → usage, expiry, last
 *     refresh, and the vault-side slot number
 *
 * If there is no active local account, we print a friendly message and
 * skip the Convex round-trip. If Convex returns null (the active local
 * sub isn't in the vault), we print local info + a note.
 *
 * Note: the slot displayed is the VAULT slot (from Convex), not the
 * legacy local slot. On native there is one active credential at a time;
 * the vault is the source of truth for slot numbers.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { makeVaultClient } from '../convex/vaultClient'
import { getActiveAccount } from '../credentials'
import { formatRelativeMs } from '../render/table'

export async function runStatus(): Promise<void> {
  const active = getActiveAccount()
  if (active === null) {
    console.log('No active Claude Code account on this machine.')
    console.log('Run `cvault switch <slot|email>` to activate one.')
    return
  }

  const client = await makeVaultClient()
  const meta = await client.query(api.subscriptions.queries.getMetaByEmail, {
    email: active.email,
  })

  if (!meta) {
    console.log(`Active: ${active.email}`)
    console.log('  This account is not in the vault. Run `cvault add` to capture it.')
    return
  }

  const now = Date.now()
  const lines = [
    `Active: ${meta.email} (slot ${String(meta.slot)})${meta.label ? ` "${meta.label}"` : ''}`,
    `  Plan:           ${meta.subscriptionType} (${meta.rateLimitTier})`,
    `  Access expires: ${formatRelativeMs(meta.expiresAt, now)}`,
    `  Last refreshed: ${formatRelativeMs(meta.lastRefreshedAt, now)}`,
  ]
  if (meta.usage5h) lines.push(`  5h usage:       ${String(Math.round(meta.usage5h.pct))}%`)
  if (meta.usage7d) lines.push(`  7d usage:       ${String(Math.round(meta.usage7d.pct))}%`)
  if (meta.refreshExpiresAt !== undefined && meta.refreshExpiresAt <= now) {
    lines.push('  Status:         relogin required (refresh token expired)')
  }
  console.log(lines.join('\n'))
}

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show the currently-active sub with vault metadata.',
  },
  async run() {
    await runStatus()
  },
})
