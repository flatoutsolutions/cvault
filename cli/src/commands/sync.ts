/**
 * `cvault sync --all` — bootstrap a fresh machine.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * For every sub the user has in the vault:
 *   1. Pull plaintext via `pullForSwitch` (server refreshes if needed)
 *   2. Wrap as a single-account envelope and `claude-swap --import -`
 *   3. Update `~/.vault/last-hash-{email}.txt`
 *
 * Continues on per-sub failure so one bad sub (e.g. expired refresh
 * token) doesn't block the rest. Errors are printed to stderr.
 *
 * No `--switch-to` at the end — the user picks the active sub
 * afterward via `cvault switch`.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { importEnvelope } from '../claudeSwap'
import { type VaultClient, makeVaultClient } from '../convex/vaultClient'
import { buildSingleAccountEnvelope } from '../envelope'
import { lastHashPath, writeSecret } from '../paths'

interface SubMetaListed {
  email: string
  slot: number
}

async function syncOne(client: VaultClient, sub: SubMetaListed): Promise<void> {
  const pull = await client.action(api.subscriptions.actions.pullForSwitch, {
    slotOrEmail: sub.email,
  })

  const envelope = buildSingleAccountEnvelope(pull)
  importEnvelope(envelope, true)
  await writeSecret(lastHashPath(pull.email), pull.contentHash)
}

export async function runSync(): Promise<void> {
  const client = await makeVaultClient()
  const subs = await client.query(api.subscriptions.queries.listForUser, {})

  if (subs.length === 0) {
    console.log('No subscriptions to sync.')
    return
  }

  console.log(`Syncing ${String(subs.length)} subscription(s)...`)
  for (const sub of subs) {
    try {
      await syncOne(client, sub)
      console.log(`  ✓ ${sub.email} (slot ${String(sub.slot)})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  ✗ ${sub.email} (slot ${String(sub.slot)}): ${msg}`)
    }
  }
}

export const syncCommand = defineCommand({
  meta: {
    name: 'sync',
    description: 'Pull all subscriptions from the vault and import each.',
  },
  args: {
    all: {
      type: 'boolean',
      description: 'Sync all subscriptions (currently the only mode).',
      required: false,
      default: true,
    },
  },
  async run() {
    await runSync()
  },
})
