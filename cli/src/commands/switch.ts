/**
 * `cvault switch <slot|email>` — pull-on-use credential rotation +
 * activation.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Steps:
 *   1. Convex action `pullForSwitch` — server refreshes the access token
 *      if it expires soon, decrypts, returns plaintext + contentHash.
 *   2. Compare contentHash to `~/.vault/last-hash-{email}.txt`.
 *      Match → skip import (active credentials already up to date).
 *   3. Mismatch → wrap plaintext in a single-account envelope and apply
 *      it via `importEnvelope` (writes Keychain/credentials file +
 *      `~/.claude.json` oauthAccount slice). Update the local hash file.
 *
 * Offline behavior:
 *   On native there is no per-slot local backup pool, so the legacy
 *   "fall back to a local switch" path is meaningless — `switchTo()` is
 *   a no-op. We instead fail loud: print a clear error explaining that
 *   credentials cannot be rotated without Convex, and exit non-zero.
 *   Users with a previously-imported sub still have it active locally;
 *   they just can't rotate to a different one.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { makeVaultClient } from '../convex/vaultClient'
import { importEnvelope } from '../credentials'
import { buildSingleAccountEnvelope } from '../envelope'
import { lastHashPath, readSecret, writeSecret } from '../paths'

export interface RunSwitchOptions {
  slotOrEmail: string
}

interface PullResult {
  email: string
  slot: number
  plaintextBlob: string
  contentHash: string
}

/**
 * Heuristic for "Convex is unreachable, not just returning an auth/server
 * error." Anything that looks like a DNS failure, connection refused, or
 * generic fetch failure trips a clear offline message; non-network
 * errors propagate verbatim so real bugs don't get swallowed.
 */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('network') ||
    msg.includes('connection') ||
    msg.includes('timeout') ||
    msg.includes('dns')
  )
}

class OfflineError extends Error {
  override readonly name = 'OfflineError'
  constructor() {
    super(
      `Convex is unreachable. Cannot rotate credentials without the vault. ` +
        `The previously-active sub (if any) is still usable locally; reconnect to switch.`
    )
  }
}

export async function runSwitch(opts: RunSwitchOptions): Promise<void> {
  let pull: PullResult
  try {
    const client = await makeVaultClient()
    pull = await client.action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: opts.slotOrEmail,
    })
  } catch (err) {
    if (isNetworkError(err)) {
      throw new OfflineError()
    }
    throw err
  }

  // Compare server-side content hash with our local cache.
  const hashPath = lastHashPath(pull.email)
  const localHash = await readSecret(hashPath)

  if (localHash !== pull.contentHash) {
    const envelope = buildSingleAccountEnvelope(pull)
    await importEnvelope(envelope, true)
    await writeSecret(hashPath, pull.contentHash)
  }

  console.log(`Active credentials are now ${pull.email}.`)
}

export const switchCommand = defineCommand({
  meta: {
    name: 'switch',
    description: 'Switch the active Claude Code login by slot or email.',
  },
  args: {
    target: {
      type: 'positional',
      description: 'Slot number or email of the subscription to activate.',
      required: true,
    },
  },
  async run({ args }) {
    await runSwitch({ slotOrEmail: args.target })
  },
})
