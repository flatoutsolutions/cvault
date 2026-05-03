/**
 * `cvault add` — capture the currently-active Claude Code login and ship
 * it to the Convex vault. Non-destructive: reads what's already on disk;
 * does NOT spawn `claude auth login` or modify the Keychain.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Flow:
 *   1. Read the active credentials + `~/.claude.json` `oauthAccount`.
 *   2. If nothing is active, error with a hint to run `claude auth login`
 *      first. We deliberately do not spawn `claude` ourselves — `add`
 *      means "snapshot what I have"; users who want a fresh login can
 *      run it explicitly. (cvault-1's earlier rewrite spawned `claude`
 *      and replaced the existing cred, which surprised users on a
 *      machine where the active sub was the one they wanted to capture.)
 *   3. POST plaintext + metadata to Convex via
 *      `subscriptions.actions.upsertFromPlaintext`. The action encrypts
 *      server-side under VAULT_AES_KEY; the CLI never sees the master key.
 *
 * Native has exactly one active credential at a time, so there's no slot
 * lookup — Convex owns the vault slot and returns it from upsert.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { makeVaultClient } from '../convex/vaultClient'
import { exportAccount, getActiveAccount } from '../credentials'

export interface RunAddOptions {
  /** Optional human label to assign to the new sub. */
  label?: string
}

export async function runAdd(opts: RunAddOptions): Promise<void> {
  // Verify there IS an active credential to capture. If not, bail with a
  // clear hint instead of silently uploading an empty record (or
  // surprising the user by spawning `claude auth login`).
  const active = getActiveAccount()
  if (active === null) {
    throw new Error(
      'No active Claude Code account on this machine.\n' +
        'Run `claude auth login` to sign in, then re-run `cvault add`.'
    )
  }

  console.log(`Capturing active Claude Code login for ${active.email}...`)

  // Build a single-account envelope from the on-disk state. `exportAccount`
  // returns whatever `claude` already wrote to the Keychain + claude.json.
  // No subprocess spawn, no destructive op.
  const envelope = exportAccount(1)
  const account = envelope.accounts[0]
  if (!account) {
    throw new Error('buildEnvelope returned no account from the active credentials')
  }

  const oauth = account.credentials.claudeAiOauth
  // Round-trip ALL fields legacy `claude-swap --import` required.
  // Specifically, `credentials` and `config` must be JSON objects on
  // import. We capture the source `config.oauthAccount` (and the
  // organization metadata) into the encrypted blob so a later `cvault
  // switch` can rebuild a complete envelope on the destination machine.
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

  await client.action(
    api.subscriptions.actions.upsertFromPlaintext,
    client.withMachineLabel({
      email: account.email,
      plaintextBlob,
      expiresAt: oauth.expiresAt,
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: 'tier1', // PENDING: Anthropic /api/oauth/usage exposes this
      ...(opts.label !== undefined ? { label: opts.label } : {}),
    })
  )

  console.log(`\nAdded ${account.email} to the vault.`)
}

export const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Snapshot the active Claude Code login and upload it to the vault.',
  },
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
