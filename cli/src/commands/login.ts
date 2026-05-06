/**
 * `cvault login` — browser-assisted Clerk sign-in via the dashboard's
 * `/cli/link` page + a localhost callback that captures the one-time
 * sign-in token.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7 +
 * docs/research/clerk-convex-tanstack-integration.md §4-5.
 *
 * Flow:
 *   1. Bind 127.0.0.1 on a random free port via `startCallbackServer`
 *   2. Open the user's browser to `${dashboardUrl}/cli/link?redirect=...&state=...`
 *   3. The dashboard signs the user in (or recognizes existing session),
 *      mints a Clerk sign-in token via the Convex `cli.startLink` action,
 *      then POSTs it to our callback
 *   4. We exchange the ticket for a long-lived Clerk session via FAPI
 *   5. Capture the machine label (`--label` override or `os.hostname()`)
 *      and persist `~/.vault/session.json`
 *   6. Best-effort `cli.recordLogin` audit row tagged with the machine label
 */
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { defineCommand } from 'citty'

import { api } from '../../../convex/_generated/api'
import { startCallbackServer } from '../auth/callbackServer'
import { ClerkEmailDomainNotAllowedError, exchangeTicketForSession } from '../auth/clerkFapi'
import { openBrowser } from '../auth/openBrowser'
import { writeSession } from '../auth/session'
import { resolveConfig } from '../config'
import { VaultClient } from '../convex/vaultClient'

export interface RunLoginOptions {
  /** Dashboard URL (e.g. https://app.cvault.dev). */
  dashboardUrl: string
  /** Convex deployment URL. */
  convexUrl: string
  /** Clerk Frontend API URL. */
  frontendApiUrl: string
  /** Optional Clerk-allowed origin for FAPI's CORS check. */
  dashboardOrigin?: string
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
 *
 * Trim + collapse whitespace so a stray space in the flag doesn't make
 * the dashboard show "  air-13  " indented funny. Empty / whitespace-only
 * input falls through to `os.hostname()` rather than persisting an
 * empty string (which would be indistinguishable from "no label" in
 * the optional-string Convex validator).
 */
function resolveMachineLabel(override?: string): string {
  if (override !== undefined) {
    const trimmed = override.trim()
    if (trimmed.length > 0) return trimmed
  }
  return hostname()
}

export async function runLogin(opts: RunLoginOptions): Promise<void> {
  const state = randomUUID()
  const handle = startCallbackServer({
    expectedState: state,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })

  const linkUrl = new URL('/cli/link', opts.dashboardUrl)
  linkUrl.searchParams.set('redirect', `http://127.0.0.1:${String(handle.port)}/`)
  linkUrl.searchParams.set('state', state)

  console.log(`Opening browser for sign-in:\n  ${linkUrl.toString()}\n`)
  console.log('If the browser does not open automatically, copy the URL above.')
  await openBrowser(linkUrl.toString())

  console.log('\nWaiting for sign-in to complete (Ctrl-C to cancel)...')

  let signInToken: string
  try {
    const result = await handle.result
    if (result.cancelled) {
      throw new Error('Login cancelled')
    }
    signInToken = result.signInToken
  } catch (err) {
    await handle.cancel()
    throw err
  }

  let session
  try {
    session = await exchangeTicketForSession({
      signInToken,
      frontendApiUrl: opts.frontendApiUrl,
      convexUrl: opts.convexUrl,
      ...(opts.dashboardOrigin !== undefined ? { dashboardOrigin: opts.dashboardOrigin } : {}),
    })
  } catch (err) {
    // Make sure the callback server is fully torn down even on exchange failure.
    await handle.cancel()
    if (err instanceof ClerkEmailDomainNotAllowedError) {
      // Bespoke two-line render: the server message + a login-specific
      // "sign out and retry with an allowlisted email" hint. Lives here
      // (not in `formatCliError`) because the hint only applies to the
      // interactive login flow — non-login commands hitting this class
      // through the retry path can't meaningfully "sign out and try
      // again with allowlisted email" mid-call. Out of scope for the
      // unified-dispatch follow-up.
      console.error(`Error: ${err.serverMessage}`)
      console.error('Sign out at the cvault dashboard and try again with an allowlisted email.')
      process.exit(1)
    }
    // Wrong-deployment hijack (`ConvexEndpointNotFoundError`) is now
    // dispatched centrally by `cli/src/render/cliError.ts:formatCliError`
    // so login + every other CLI command renders identically. Re-throw
    // and let the top-level catch in `cli/src/index.ts` format + exit.
    throw err
  }

  // Capture the machine label NOW (post-exchange, pre-write) so it lands
  // on the persisted session and on the recordLogin audit row in one
  // shot. Subsequent commands read `session.machineLabel` and forward it
  // to every action that writes machineActivity.
  const machineLabel = resolveMachineLabel(opts.machineLabel)
  const sessionWithLabel = { ...session, machineLabel }
  await writeSession(sessionWithLabel)

  // Audit: record this CLI machine in machineActivity. Best-effort — login
  // already succeeded, so we don't fail the command if the audit row can't
  // be written (e.g. user's Clerk webhook hasn't fired yet to create the
  // users row).
  try {
    const client = new VaultClient(sessionWithLabel)
    await client.action(api.cli.actions.recordLogin, client.withMeta({}))
  } catch (err) {
    console.warn('Login succeeded but machine-activity audit row failed:', err instanceof Error ? err.message : err)
  }

  console.log('\nSigned in successfully. You can close the browser tab.')
}

/**
 * citty command — wires `cvault login` to `runLogin` with config resolved
 * from env vars + bundled defaults.
 */
export const loginCommand = defineCommand({
  meta: { name: 'login', description: 'Sign in via the cvault dashboard.' },
  args: {
    dashboardUrl: {
      type: 'string',
      description: 'Override dashboard URL (defaults to bundled value).',
      required: false,
    },
    label: {
      type: 'string',
      description:
        'Friendly machine name for the dashboard’s "Machines" view. ' + 'Defaults to the OS hostname when omitted.',
      required: false,
    },
  },
  async run({ args }) {
    const config = resolveConfig()
    await runLogin({
      dashboardUrl: args.dashboardUrl ?? config.dashboardUrl,
      convexUrl: config.convexUrl,
      frontendApiUrl: config.frontendApiUrl,
      ...(args.label !== undefined ? { machineLabel: args.label } : {}),
    })
  },
})
