/**
 * `cvault list` — render every subscription in the vault.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Sources:
 *   - Convex `api.subscriptions.queries.listForUser` for sub metadata
 *     (no ciphertext, no plaintext — just slot, email, label, usage,
 *      expiry, last refresh)
 *   - Local `getActiveAccount()` (from `credentials.ts`) for the
 *     currently-active sub on this machine
 *
 * The active marker is keyed off EMAIL not slot — slot numbers are owned
 * by Convex and the vault's slot for a sub may differ from the legacy
 * "active slot" string the local `status()` produced. Email is the
 * stable identifier that survives renumbers + cross-machine sync.
 *
 * If reading the local active account fails (no credentials, malformed
 * claude.json), we still render the table — just without an active
 * marker.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { makeVaultClient } from '../convex/vaultClient'
import { getActiveAccount } from '../credentials'
import { type SubRow, renderSubsTable } from '../render/table'

export async function runList(): Promise<void> {
  const client = await makeVaultClient()
  const subs = await client.query(api.subscriptions.queries.listForUser, {})

  // R2: case-insensitive compare. Anthropic emails are case-insensitive
  // at SMTP and Clerk normalizes inconsistently; lower-case both sides
  // so `Stefan@example.com` (vault) matches `stefan@example.com`
  // (`oauthAccount`).
  let activeEmailLower: string | undefined
  try {
    const email = getActiveAccount()?.email
    activeEmailLower = email !== undefined ? email.toLowerCase() : undefined
  } catch {
    // Reading the local credentials store may fail (perms, missing
    // claude.json, etc.). Render the table without an active marker
    // rather than aborting — the user can still see what's in the vault.
    activeEmailLower = undefined
  }

  // Rank is the 1-indexed position in the server response. The server
  // returns subs ordered by `_creationTime` ASC (FCFS, see
  // `convex/subscriptions/queries.ts:list`), so the rendered rank
  // matches the ordinal `cvault switch <N>` resolves on the server
  // side. Critically, this is NOT `s.slot` — in the shared vault every
  // user's first sub has `slot=1`, which would render duplicate `1`s.
  const rows: SubRow[] = subs.map((s, index) => ({
    rank: index + 1,
    email: s.email,
    label: s.label,
    expiresAt: s.expiresAt,
    refreshExpiresAt: s.refreshExpiresAt,
    lastRefreshedAt: s.lastRefreshedAt,
    usage5hPct: s.usage5h?.pct,
    usage7dPct: s.usage7d?.pct,
    isActive: activeEmailLower !== undefined && s.email.toLowerCase() === activeEmailLower,
  }))

  console.log(renderSubsTable(rows))

  // Footer: explain the `⚠ relogin` STATUS marker so users have an
  // immediate next-step when a row is flagged. Only print when at
  // least one row needs re-capture — otherwise the footer is noise.
  const now = Date.now()
  const reloginCount = rows.filter((r) => r.refreshExpiresAt !== undefined && r.refreshExpiresAt <= now).length
  if (reloginCount > 0) {
    console.log('')
    console.log(
      `Subs marked ⚠ need re-capture. Run \`cvault add\` on the machine where you most recently used \`claude\` to recapture them.`
    )
  }
}

export const listCommand = defineCommand({
  meta: { name: 'list', description: 'List all subscriptions in the vault.' },
  async run() {
    await runList()
  },
})
