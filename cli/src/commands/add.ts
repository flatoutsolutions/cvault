/**
 * `cvault add` — capture the currently-active Claude Code login and ship
 * it to the Convex vault.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Flow:
 *   1. `claude-swap --add-account` (interactive — uses the user's terminal)
 *   2. `claude-swap --status` to learn the new active slot
 *   3. `claude-swap --export - --account <slot>` to capture the OAuth blob
 *   4. POST to Convex via `subscriptions.actions.upsertFromPlaintext`
 *
 * The Convex action encrypts the plaintext blob server-side using the
 * master key in `VAULT_AES_KEY`. The CLI never sees the master key.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { addAccountInteractive, status as csStatus, exportAccount } from '../claudeSwap'
import { makeVaultClient } from '../convex/vaultClient'

/**
 * Parse `claude-swap --status` output to find the active slot number.
 *
 * Real claude-swap output (verified against the installed binary) looks
 * like:
 *
 *   Status: Account-1 (user@example.com [Org Name])
 *     Total managed accounts: 2
 *
 * Older / hypothetical formats also accepted: `Active account: N`,
 * `Current account: N`. The regex matches `Account` followed by one of
 * `\s`, `-`, `_`, `:` and the digit — that excludes the trailing summary
 * line `Total managed accounts: 2` (the `s` after `account` blocks the
 * separator class).
 */
function parseActiveSlot(statusOutput: string): number {
  const match = /Account[\s\-_:]+(\d+)/i.exec(statusOutput)
  if (!match || match[1] === undefined) {
    throw new Error(`Could not determine active slot from claude-swap --status output:\n${statusOutput}`)
  }
  return Number.parseInt(match[1], 10)
}

export interface RunAddOptions {
  /** Optional human label to assign to the new sub. */
  label?: string
}

export async function runAdd(opts: RunAddOptions): Promise<void> {
  console.log('Capturing the currently-active Claude Code login...')
  console.log('Run `claude --login` first if you are not yet signed in.\n')

  // Phase 1 — interactive add. claude-swap prompts the user.
  await addAccountInteractive()

  // Phase 2 — find the new slot and export it.
  const statusOut = csStatus()
  const slot = parseActiveSlot(statusOut)

  const envelope = exportAccount(slot)
  const account = envelope.accounts[0]
  if (!account) {
    throw new Error(`claude-swap --export returned no account for slot ${String(slot)}`)
  }

  const oauth = account.credentials.claudeAiOauth
  // Round-trip ALL fields claude-swap requires on import. Specifically,
  // claude-swap rejects an envelope where `credentials` and `config` are
  // not both JSON objects ("must be JSON objects" error from
  // claude-swap --import). We capture the source `config` (and the
  // organization metadata) into the encrypted blob so a later
  // `cvault switch` can rebuild a complete envelope on the destination
  // machine.
  const plaintextBlob = JSON.stringify({
    claudeAiOauth: oauth,
    config: account.config ?? {},
    uuid: account.uuid,
    organizationUuid: account.organizationUuid,
    organizationName: account.organizationName,
  })

  // Phase 3 — POST to Convex. The action encrypts server-side under
  // VAULT_AES_KEY; the CLI never holds the master key.
  const client = await makeVaultClient()

  await client.action(api.subscriptions.actions.upsertFromPlaintext, {
    email: account.email,
    plaintextBlob,
    expiresAt: oauth.expiresAt,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: 'tier1', // PENDING: Anthropic /api/oauth/usage exposes this
    ...(opts.label !== undefined ? { label: opts.label } : {}),
  })

  console.log(`\nAdded ${account.email} (slot ${String(slot)}) to the vault.`)
}

export const addCommand = defineCommand({
  meta: { name: 'add', description: 'Capture the active Claude Code login.' },
  args: {
    label: {
      type: 'string',
      description: 'Optional nickname for this account in `cvault list`.',
      required: false,
    },
  },
  async run({ args }) {
    await runAdd(args.label !== undefined ? { label: args.label } : {})
  },
})
