/**
 * `cvault login` — browser-assisted OAuth Authorization Code + PKCE flow.
 *
 * Spec: docs/superpowers/plans/2026-06-03-cli-oauth-pkce.md §Task 15.
 *
 * Flow:
 *   1. Generate a PKCE code verifier + S256 challenge
 *   2. Generate a random `state` nonce
 *   3. Bind 127.0.0.1 on a registered fixed port (OAUTH_REDIRECT_PORTS, with
 *      a fallback list) via `startCallbackServer` (async) — Clerk exact-matches
 *      the redirect URI, so the port can't be random
 *   4. Open the user's browser to the Clerk OAuth authorize URL
 *   5. Wait for the browser redirect → callback server captures `code`
 *   6. Exchange the code for OAuth tokens via PKCE
 *   7. Load (or generate) the persistent machine id
 *   8. Persist `~/.vault/session.json` (v2 shape with OAuth tokens)
 *   9. Best-effort `cli.recordLogin` audit row tagged with machineId + label
 */
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { defineCommand } from 'citty'

import { api } from '../../../convex/_generated/api'
import { startCallbackServer } from '../auth/callbackServer'
import { loadOrCreateMachineId } from '../auth/machineId'
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../auth/oauthPkce'
import { openBrowser } from '../auth/openBrowser'
import { codeChallengeS256, generateCodeVerifier } from '../auth/pkce'
import { type SessionState, writeSession } from '../auth/session'
import { resolveConfig } from '../config'
import { VaultClient } from '../convex/vaultClient'

export interface RunLoginOptions {
  /** Convex deployment URL. */
  convexUrl: string
  /** Clerk Frontend API URL. */
  frontendApiUrl: string
  /** Clerk OAuth Application Client ID. */
  clientId: string
  /** Total time before the localhost listener gives up (ms). */
  timeoutMs?: number
  /**
   * Friendly identifier for this machine (used by the dashboard's
   * "Machines" view + every audit row). Defaults to `os.hostname()`
   * when omitted; users can override with `--label`.
   */
  machineLabel?: string
}

/**
 * Resolve the label that goes on the session + every machineActivity
 * row. The CLI flag wins when supplied; otherwise we fall back to the
 * OS hostname so dashboards never display a session as "(no label)".
 */
function resolveMachineLabel(override?: string): string {
  if (override !== undefined) {
    const trimmed = override.trim()
    if (trimmed.length > 0) return trimmed
  }
  return hostname()
}

export async function runLogin(opts: RunLoginOptions): Promise<void> {
  const verifier = generateCodeVerifier()
  const challenge = codeChallengeS256(verifier)
  const state = randomUUID()

  const handle = await startCallbackServer({
    expectedState: state,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })
  const redirectUri = `http://127.0.0.1:${String(handle.port)}/`

  const authorizeUrl = buildAuthorizeUrl({
    frontendApiUrl: opts.frontendApiUrl,
    clientId: opts.clientId,
    redirectUri,
    scope: 'openid email profile offline_access',
    codeChallenge: challenge,
    state,
  })
  console.log(`Opening browser for sign-in:\n  ${authorizeUrl}\n`)
  console.log('If the browser does not open automatically, copy the URL above.')
  await openBrowser(authorizeUrl)

  console.log('\nWaiting for sign-in to complete (Ctrl-C to cancel)...')

  let code: string
  try {
    const result = await handle.result
    if (result.cancelled) throw new Error('Login cancelled')
    code = result.code
  } catch (err) {
    await handle.cancel()
    throw err
  }

  const tokens = await exchangeCodeForTokens({
    frontendApiUrl: opts.frontendApiUrl,
    clientId: opts.clientId,
    code,
    codeVerifier: verifier,
    redirectUri,
  })

  const machineId = await loadOrCreateMachineId()
  const machineLabel = resolveMachineLabel(opts.machineLabel)
  const session: SessionState = {
    version: 2,
    accessToken: tokens.accessToken,
    accessTokenExpiry: tokens.accessTokenExpiry,
    refreshToken: tokens.refreshToken,
    ...(tokens.idToken !== undefined ? { idToken: tokens.idToken } : {}),
    frontendApiUrl: opts.frontendApiUrl,
    clientId: opts.clientId,
    convexUrl: opts.convexUrl,
    machineLabel,
  }
  await writeSession(session)

  // Audit: record this CLI machine in devices + machineActivity. Best-effort —
  // login already succeeded, so we don't fail the command if the audit row
  // can't be written (e.g. user's Clerk webhook hasn't fired yet to create the
  // users row).
  try {
    const client = new VaultClient(session, machineId)
    await client.action(api.cli.actions.recordLogin, { machineId, machineLabel })
  } catch (err) {
    // Check for the domain-gate error (EMAIL_DOMAIN_NOT_ALLOWED). The server
    // rejects at the recordLogin call when the user's email domain is not on
    // the allowlist. Surface a friendly hint.
    const msg = err instanceof Error ? err.message : String(err)
    if (/DOMAIN_REJECTION_ERROR_CODE|email.*domain.*not.*allow|domain.*not.*allow/i.test(msg)) {
      console.error(`Error: ${msg}`)
      console.error('Sign out at the cvault dashboard and try again with an allowlisted email.')
      process.exit(1)
    }
    console.warn('Login succeeded but device-registration audit failed:', msg)
  }

  console.log('\nSigned in successfully. You can close the browser tab.')
}

/**
 * citty command — wires `cvault login` to `runLogin` with config resolved
 * from env vars + bundled defaults.
 */
export const loginCommand = defineCommand({
  meta: { name: 'login', description: 'Sign in via Clerk OAuth (PKCE).' },
  args: {
    label: {
      type: 'string',
      description:
        'Friendly machine name for the dashboard machine view. ' + 'Defaults to the OS hostname when omitted.',
      required: false,
    },
  },
  async run({ args }) {
    const config = resolveConfig()
    await runLogin({
      convexUrl: config.convexUrl,
      frontendApiUrl: config.frontendApiUrl,
      clientId: config.clientId,
      ...(args.label !== undefined ? { machineLabel: args.label } : {}),
    })
  },
})
