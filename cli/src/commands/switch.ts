/**
 * `cvault switch <slot|email>` — pull-on-use credential rotation + Keychain
 * switch.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Steps:
 *   1. Convex action `pullForSwitch` — server refreshes the access token
 *      if it expires soon, decrypts, returns plaintext + contentHash.
 *   2. Compare contentHash to `~/.vault/last-hash-{email}.txt`.
 *      Match → skip import (Keychain is already up to date).
 *   3. Mismatch → wrap plaintext in a single-account envelope and feed it
 *      to `claude-swap --import -`. Update the local hash file.
 *   4. `claude-swap --switch-to <slot>`.
 *
 * Offline degradation:
 *   - Convex unreachable → fall back to local `claude-swap --switch-to`
 *     directly with a printed warning (per spec §7).
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { importEnvelope, switchTo } from '../claudeSwap'
import { makeVaultClient } from '../convex/vaultClient'
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
 * generic fetch failure earns the offline fallback.
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

export async function runSwitch(opts: RunSwitchOptions): Promise<void> {
  let pull: PullResult
  try {
    const client = await makeVaultClient()
    pull = await client.action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: opts.slotOrEmail,
    })
  } catch (err) {
    if (isNetworkError(err)) {
      console.warn('warn: Convex unreachable, using local cache only')
      switchTo(opts.slotOrEmail)
      return
    }
    throw err
  }

  // Compare server-side content hash with our local cache.
  const hashPath = lastHashPath(pull.email)
  const localHash = await readSecret(hashPath)

  if (localHash !== pull.contentHash) {
    const envelope = buildSingleAccountEnvelope(pull)
    importEnvelope(envelope, true)
    await writeSecret(hashPath, pull.contentHash)
  }

  switchTo(pull.slot)
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
