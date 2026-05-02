/**
 * `cvault remove <slot|email>` — soft-remove from the server-side vault.
 * Local credentials (Keychain + `~/.claude.json`) are NOT touched.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Order of operations:
 *   1. Resolve the target slot-or-email to an email via the Convex
 *      `listForUser` query (when the user passed a number).
 *   2. Server-side soft-remove (Convex mutation `softRemove`).
 *
 * Why no local clear: an earlier version of this command also wiped
 * local credentials when the removed sub matched the active local
 * account. That surprised users who ran `cvault remove <active-slot>`
 * expecting "stop tracking in vault" and instead got logged out of
 * Claude Code (the in-RAM session kept working until process restart,
 * then went dark). Use `cvault clean` for the local-wipe case.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { type VaultClient, makeVaultClient } from '../convex/vaultClient'

export interface RunRemoveOptions {
  slotOrEmail: string
}

/** If `slotOrEmail` parses as an integer, look up the matching email; else use as-is. */
async function resolveEmail(client: VaultClient, slotOrEmail: string): Promise<string> {
  const asNum = Number.parseInt(slotOrEmail, 10)
  if (Number.isNaN(asNum) || asNum.toString() !== slotOrEmail) {
    return slotOrEmail
  }

  const subs = await client.query(api.subscriptions.queries.listForUser, {})
  const found = subs.find((s) => s.slot === asNum)
  if (!found) {
    throw new Error(`No subscription at slot ${String(asNum)}`)
  }
  return found.email
}

export async function runRemove(opts: RunRemoveOptions): Promise<void> {
  const client = await makeVaultClient()
  const email = await resolveEmail(client, opts.slotOrEmail)
  await client.mutation(api.subscriptions.mutations.softRemove, { email })
  console.log(`Removed ${email} from the vault. Local credentials untouched (use \`cvault clean\` to wipe).`)
}

export const removeCommand = defineCommand({
  meta: {
    name: 'remove',
    description: 'Soft-remove a subscription from the server-side vault. Local credentials untouched.',
  },
  args: {
    target: {
      type: 'positional',
      description: 'Slot number or email to remove.',
      required: true,
    },
  },
  async run({ args }) {
    await runRemove({ slotOrEmail: args.target })
  },
})
