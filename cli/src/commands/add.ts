/**
 * `cvault add` — capture the currently-active Claude Code login and ship
 * it to the Convex vault.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Flow:
 *   1. Detect any pre-existing active account; prompt for confirmation
 *      before overwriting (unless `--force` is passed).
 *   2. Spawn `claude` (the Claude Code CLI) interactively so the user
 *      can complete the OAuth flow in their terminal.
 *   3. Read the active credentials + `~/.claude.json` to capture the
 *      new account's OAuth blob + metadata.
 *   4. POST to Convex via `subscriptions.actions.upsertFromPlaintext`.
 *
 * The Convex action encrypts the plaintext blob server-side using the
 * master key in `VAULT_AES_KEY`. The CLI never sees the master key.
 *
 * Note: native has exactly one active credential at a time. There is no
 * per-slot pool, so the new envelope's slot is always 1 locally. The
 * vault-side slot is owned by Convex and returned in the upsert result.
 */
import { createInterface } from 'node:readline/promises'

import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { makeVaultClient } from '../convex/vaultClient'
import { addAccountInteractive, exportAccount, getActiveAccount } from '../credentials'

export interface RunAddOptions {
  /** Optional human label to assign to the new sub. */
  label?: string
  /** Skip the "you already have an active account" overwrite prompt. */
  force?: boolean
  /** Override stdin/stdout for tests. Defaults to `process.std{in,out}`. */
  io?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }
}

/**
 * If an account is already active locally, prompt the user before
 * overwriting it. The OAuth flow `claude` runs replaces the Keychain
 * entry + the `oauthAccount` slice in `~/.claude.json`, so silent
 * overwrite is a footgun for users who forgot they had a sub captured.
 */
async function confirmOverwrite(io: NonNullable<RunAddOptions['io']>, activeEmail: string): Promise<boolean> {
  const rl = createInterface({ input: io.input, output: io.output })
  try {
    const answer = await rl.question(
      `An account for ${activeEmail} is currently active on this machine.\n` +
        `Adding will replace it. Continue? [y/N] `
    )
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

export async function runAdd(opts: RunAddOptions): Promise<void> {
  // Phase 0 — overwrite guard.
  if (opts.force !== true) {
    const active = getActiveAccount()
    if (active !== null) {
      const io = opts.io ?? { input: process.stdin, output: process.stdout }
      const ok = await confirmOverwrite(io, active.email)
      if (!ok) {
        console.log('Aborted.')
        return
      }
    }
  }

  console.log('Capturing the currently-active Claude Code login...')
  console.log('The interactive flow will replace the active credentials with the new sub.\n')

  // Phase 1 — interactive add. `claude` prompts the user.
  await addAccountInteractive()

  // Phase 2 — read the freshly-written credentials + claude.json. On
  // native there's exactly one active account, so we don't need a slot
  // lookup; `exportAccount` builds a single-account envelope from the
  // active state. The slot arg to `exportAccount` is ignored; we keep
  // `1` as a placeholder for the legacy signature.
  const envelope = exportAccount(1)
  const account = envelope.accounts[0]
  if (!account) {
    throw new Error(`buildEnvelope returned no account after \`claude\` exit`)
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

  await client.action(api.subscriptions.actions.upsertFromPlaintext, {
    email: account.email,
    plaintextBlob,
    expiresAt: oauth.expiresAt,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: 'tier1', // PENDING: Anthropic /api/oauth/usage exposes this
    ...(opts.label !== undefined ? { label: opts.label } : {}),
  })

  console.log(`\nAdded ${account.email} to the vault.`)
}

export const addCommand = defineCommand({
  meta: { name: 'add', description: 'Capture the active Claude Code login.' },
  args: {
    label: {
      type: 'string',
      description: 'Optional nickname for this account in `cvault list`.',
      required: false,
    },
    force: {
      type: 'boolean',
      description: 'Skip the overwrite-prompt for an existing active account.',
      required: false,
      default: false,
    },
  },
  async run({ args }) {
    await runAdd({
      ...(args.label !== undefined ? { label: args.label } : {}),
      ...(args.force === true ? { force: true } : {}),
    })
  },
})
