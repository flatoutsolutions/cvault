/**
 * `cvault remove <slot|email>` — soft-remove from Convex + drop the local
 * Keychain entry.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Order of operations:
 *   1. Server-side soft-remove (Convex mutation `softRemove`)
 *   2. Local Keychain remove (`claude-swap --remove-account`)
 *
 * If step 1 throws, step 2 is skipped — the user can retry. If step 2
 * throws, the server has already soft-removed; the user can manually run
 * `claude-swap --remove-account <slot>` to clean up.
 *
 * The Convex mutation takes `email` not `slot`, so when the user passes a
 * number we resolve it to an email via `listForUser` first.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { removeAccount } from '../claudeSwap'
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

/** Coerce a slot-or-email arg into the form claude-swap expects (number for slots). */
function localTarget(slotOrEmail: string): string | number {
  const asNum = Number.parseInt(slotOrEmail, 10)
  if (!Number.isNaN(asNum) && asNum.toString() === slotOrEmail) {
    return asNum
  }
  return slotOrEmail
}

export async function runRemove(opts: RunRemoveOptions): Promise<void> {
  const client = await makeVaultClient()
  const email = await resolveEmail(client, opts.slotOrEmail)

  // Step 1 — server-side soft remove. If this throws, the local Keychain is
  // untouched.
  await client.mutation(api.subscriptions.mutations.softRemove, { email })

  // Step 2 — local Keychain remove. If this throws, server is still
  // soft-removed; user must clean up manually.
  removeAccount(localTarget(opts.slotOrEmail))

  console.log(`Removed ${email} from the vault.`)
}

export const removeCommand = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove a subscription from the vault and the local Keychain.',
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
