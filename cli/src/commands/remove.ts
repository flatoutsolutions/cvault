/**
 * `cvault remove <slot|email>` — soft-remove from Convex + (conditionally)
 * clear the local active credentials.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Order of operations:
 *   1. Resolve the target slot-or-email to an email via the Convex
 *      `listForUser` query (when the user passed a number).
 *   2. Server-side soft-remove (Convex mutation `softRemove`).
 *   3. ONLY if the removed sub matches the currently-active local
 *      account: clear the active credentials + `oauthAccount` slice in
 *      `~/.claude.json`.
 *
 * The "conditionally clear" guard (R4-H4) matters because native has
 * exactly one active credential at a time. If the user runs `cvault
 * remove <other-slot>` while sub-1 is active, we MUST NOT wipe sub-1's
 * local credentials — that would silently log the user out of an
 * unrelated account.
 *
 * Earlier history: a prior commit (0f21b97) dropped the local-clear
 * step entirely on the rationale that the in-RAM Claude Code session
 * keeps working until process restart, then goes dark — surprising
 * users into hunting the bug elsewhere. That trade-off cuts the wrong
 * way: removing the active sub from the vault while leaving its local
 * credentials in place leaves the user in an inconsistent state where
 * the next `cvault add` would re-upload the same row they just removed.
 * The R4-H4 conditional-clear keeps the two sides in sync without
 * touching unrelated subs.
 *
 * If step 2 throws, step 3 is skipped — the user can retry. If step 3
 * throws, the server has already soft-removed; the user can re-add via
 * `cvault add` or manually clear the Keychain.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { type VaultClient, makeVaultClient } from '../convex/vaultClient'
import { getActiveAccount, removeAccount } from '../credentials'

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

  // Step 1 — server-side soft remove. If this throws, the local
  // credentials are untouched.
  await client.mutation(api.subscriptions.mutations.softRemove, client.withMachineLabel({ email }))

  // Step 2 — local clear, but ONLY when the removed sub matches the
  // currently-active local account. Removing a non-active sub must not
  // log the user out of the account they're using right now.
  //
  // R2: case-insensitive email compare. Anthropic emails are
  // case-insensitive at SMTP, and Clerk normalizes inconsistently. If
  // the user added `Stefan@example.com` originally and `getActiveAccount`
  // returns `stefan@example.com` later (or vice versa), a strict-case
  // compare would skip the local clear when it should have fired.
  const active = getActiveAccount()
  if (active !== null && active.email.toLowerCase() === email.toLowerCase()) {
    await removeAccount(email)
    console.log(`Removed ${email} from the vault and cleared local credentials.`)
  } else {
    console.log(`Removed ${email} from the vault. (Local credentials for the active account were not touched.)`)
  }
}

export const removeCommand = defineCommand({
  meta: {
    name: 'remove',
    description:
      'Remove a subscription from the vault. Clears local credentials only if the removed sub is the active one.',
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
