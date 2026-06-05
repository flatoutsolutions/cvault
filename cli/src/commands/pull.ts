/**
 * `cvault pull` — keep the active subscription's local token fresh.
 *
 * Invoked by the `UserPromptSubmit` hook before every `claude` prompt, so it
 * MUST be cheap and MUST NOT block the prompt:
 *   - skip entirely (no network) when the local token is comfortably fresh;
 *   - otherwise pull a NEUTERED token (dead refresh token) from the vault and
 *     write it to the keychain so a running `claude` re-reads it on expiry;
 *   - swallow all errors (exit 0) so a vault/network hiccup never blocks work.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { makeVaultClient } from '../convex/vaultClient'
import { getActiveAccount, importEnvelope } from '../credentials'
import { buildSingleAccountEnvelope } from '../envelope'
import { readCredentials } from '../native/credentialStore'

/**
 * Only reach Convex when the local token has less than this much life left.
 * Aligned with the server's proactive-refresh window (`REFRESH_PROACTIVE_MS`,
 * 5 min): `pull` hits the vault right when a refresh will actually happen, so
 * it never makes redundant round-trips in a wider pre-expiry gap. (Kept as a
 * local constant rather than importing the server's internal value to avoid
 * coupling the CLI to Convex internals — keep the two in sync if either moves.)
 */
const FRESH_WINDOW_MS = 5 * 60 * 1000

function localExpiresAt(): number | undefined {
  let raw: string | null
  try {
    raw = readCredentials()
  } catch {
    return undefined
  }
  if (raw === null) return undefined
  try {
    const blob = JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: unknown } }
    const exp = blob.claudeAiOauth?.expiresAt
    return typeof exp === 'number' ? exp : undefined
  } catch {
    return undefined
  }
}

export async function runPull(): Promise<void> {
  let active: ReturnType<typeof getActiveAccount>
  try {
    active = getActiveAccount()
  } catch {
    return // keychain locked / unreadable — don't block the prompt
  }
  if (active === null) return

  const exp = localExpiresAt()
  if (exp !== undefined && exp > Date.now() + FRESH_WINDOW_MS) return // still fresh — no network

  const client = await makeVaultClient()
  const pull = await client.action(
    api.subscriptions.actions.pullForSwitch,
    client.withMeta({ slotOrEmail: active.email, neuterRefreshToken: true })
  )
  await importEnvelope(buildSingleAccountEnvelope(pull), true)
}

export const pullCommand = defineCommand({
  meta: {
    name: 'pull',
    description: 'Refresh the active subscription token from the vault (used by the claude hook).',
  },
  async run() {
    try {
      await runPull()
    } catch (err) {
      // Best-effort: never block the prompt. Log to stderr for diagnostics.
      console.error('cvault pull:', err instanceof Error ? err.message : String(err))
    }
  },
})
