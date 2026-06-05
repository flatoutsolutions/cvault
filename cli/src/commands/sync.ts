/**
 * `cvault sync --all` — bootstrap a fresh machine.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * For every sub the user has in the vault:
 *   1. Pull plaintext via `pullForSwitch` (server refreshes if needed)
 *   2. Wrap as a single-account envelope and apply via `importEnvelopeUnlocked`
 *   3. Update `~/.vault/last-hash-{email}.txt`
 *
 * Concurrency: the WHOLE per-sub loop runs under a single
 * `withFileLock` call. Holding the lock across the batch is what
 * prevents a concurrent `cvault switch` (or a second `cvault sync`)
 * from interleaving its write between sync's iteration N and iteration
 * N+1. Per-sub writes use `importEnvelopeUnlocked` (NOT
 * `importEnvelope`) because proper-lockfile is not reentrant within
 * one process — calling `importEnvelope` from inside `withFileLock`
 * would deadlock waiting for self.
 *
 * Continues on per-sub failure so one bad sub (e.g. expired refresh
 * token) doesn't block the rest. Errors are printed to stderr.
 *
 * Note: on native there is exactly one active credential at a time, so
 * the LAST imported sub becomes the active one. The user may then run
 * `cvault switch <slot|email>` to pick a specific one as active.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { type VaultClient, makeVaultClient } from '../convex/vaultClient'
import { importEnvelopeUnlocked } from '../credentials'
import { buildSingleAccountEnvelope } from '../envelope'
import { withFileLock } from '../native/lock'
import { lastHashPath, writeSecret } from '../paths'

interface SubMetaListed {
  email: string
  slot: number
}

async function syncOneUnlocked(client: VaultClient, sub: SubMetaListed): Promise<void> {
  const pull = await client.action(
    api.subscriptions.actions.pullForSwitch,
    client.withMeta({ slotOrEmail: sub.email, neuterRefreshToken: true })
  )

  const envelope = buildSingleAccountEnvelope(pull)
  importEnvelopeUnlocked(envelope, true)
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

  // Hold the cross-process credentials lock across the WHOLE per-sub
  // loop. See the file header for the rationale; in short: per-sub
  // locking would let other writers interleave between iterations.
  await withFileLock(async () => {
    // R: render the 1-indexed position in the FCFS-ordered server
    // response as "rank N" — NOT the stored `slot`. In the shared
    // vault every user's first sub has `slot=1`, so printing `slot`
    // would produce duplicate "(slot 1)" lines whenever the caller
    // owns more than one sub. Same fix the `list` command got in
    // commit 10b10a9.
    //
    // `entries()` returns `[number, T]` typed correctly under
    // `noUncheckedIndexedAccess`, so we don't need the prior
    // `if (sub === undefined) continue` guard that the index-loop form
    // required.
    for (const [index, sub] of subs.entries()) {
      const rank = index + 1
      try {
        await syncOneUnlocked(client, sub)
        console.log(`  ✓ ${sub.email} (rank ${String(rank)})`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  ✗ ${sub.email} (rank ${String(rank)}): ${msg}`)
      }
    }
  })
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
