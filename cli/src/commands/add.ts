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
import { type ClaudeSwapEnvelope, exportAccount, getActiveAccount, importEnvelope } from '../credentials'

export interface RunAddOptions {
  /** Optional human label to assign to the new sub. */
  label?: string
}

/**
 * Sentinel the vault writes in place of a usable refresh token on
 * `switch`/`pull`/`sync` so clients can never rotate the shared grant. Kept
 * in sync with `NEUTERED_REFRESH_TOKEN` in `convex/subscriptions/actions.ts`
 * (not imported, to keep server modules out of the CLI bundle). The vault
 * rejects a neutered upsert authoritatively; this is the fail-fast client
 * guard so we never even make the round-trip.
 */
const NEUTERED_REFRESH_TOKEN = 'cvault-neutered-no-refresh'

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
  if (oauth.refreshToken === NEUTERED_REFRESH_TOKEN) {
    throw new Error(
      `The active credential for ${active.email} is a neutered (vault-managed) token, not a real login.\n` +
        'This happens after `cvault switch`/`pull`. The vault already owns this account — there is nothing to capture.\n' +
        'To re-capture, run `cvault add` on a machine where you signed in to claude directly.'
    )
  }
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
    client.withMeta({
      email: account.email,
      plaintextBlob,
      expiresAt: oauth.expiresAt,
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: 'tier1', // PENDING: Anthropic /api/oauth/usage exposes this
      ...(opts.label !== undefined ? { label: opts.label } : {}),
    })
  )

  // Neuter the LOCAL refresh token now that the vault has the real one. The
  // vault is the SOLE refresher; the adder's machine must end up in the same
  // state as every machine that received the sub via switch/sync/pull —
  // holding the (still-valid) access token plus a DEAD refresh token. Without
  // this, this machine's `claude` would autonomously rotate the real token at
  // expiry and invalidate the vault's copy for everyone else.
  const neutered: ClaudeSwapEnvelope = {
    ...envelope,
    accounts: [{ ...account, credentials: { claudeAiOauth: { ...oauth, refreshToken: NEUTERED_REFRESH_TOKEN } } }],
  }
  try {
    await importEnvelope(neutered, true)
  } catch (err) {
    throw new Error(
      `Uploaded ${account.email} to the vault, but FAILED to neuter the local refresh token: ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        `Run \`cvault switch ${account.email}\` to neuter it — until then this machine may rotate the shared token.`
    )
  }

  console.log(`\nAdded ${account.email} to the vault. This machine's local token is now neutered.`)
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
