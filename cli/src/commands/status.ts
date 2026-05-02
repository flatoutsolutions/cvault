/**
 * `cvault status` — show the currently-active sub with server-side meta.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Combines:
 *   - `claude-swap --status` → active slot + email
 *   - `api.subscriptions.queries.getMetaByEmail` → usage, expiry, last refresh
 *
 * If `claude-swap --status` shows no active account, we print a friendly
 * message and skip the Convex round-trip. If Convex returns null (the
 * active local sub isn't in the vault), we print local info + a note.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { status as csStatus } from '../claudeSwap'
import { makeVaultClient } from '../convex/vaultClient'
import { formatRelativeMs } from '../render/table'

interface ParsedStatus {
  slot: number
  email: string
}

/**
 * Parse `claude-swap --status` for {slot, email}. Real binary output
 * (verified 2026-05-02):
 *
 *   Status: Account-1 (samuel.asseg@gmail.com [Org Name])
 *
 * Older / hypothetical formats also accepted: `Active account: N (email)`,
 * `Current account: N (email)`. The email capture stops at the first
 * whitespace, `)` or `[` so the trailing `[org]` annotation is not
 * swallowed. See also `parseActiveSlot` in add.ts / list.ts.
 */
function parseStatus(out: string): ParsedStatus | undefined {
  const m = /Account[\s\-_:]+(\d+)[^(]*\(\s*([^\s)\]]+)/i.exec(out)
  if (!m || m[1] === undefined || m[2] === undefined) return undefined
  return { slot: Number.parseInt(m[1], 10), email: m[2].trim() }
}

export async function runStatus(): Promise<void> {
  const localOut = csStatus()
  const parsed = parseStatus(localOut)
  if (!parsed) {
    console.log('No active Claude Code account on this machine.')
    console.log('Run `cvault switch <slot|email>` to activate one.')
    return
  }

  const client = await makeVaultClient()
  const meta = await client.query(api.subscriptions.queries.getMetaByEmail, {
    email: parsed.email,
  })

  if (!meta) {
    console.log(`Active: ${parsed.email} (slot ${String(parsed.slot)})`)
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
