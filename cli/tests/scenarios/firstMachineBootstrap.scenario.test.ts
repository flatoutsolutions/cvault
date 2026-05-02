/**
 * Scenario #1 — First-machine bootstrap (`cvault login`).
 *
 * Plan: docs/research/scenario-tests-plan.md §4.1.
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7
 *  + docs/research/clerk-convex-tanstack-integration.md §4-5.
 *
 * What this scenario covers end-to-end:
 *  - `runLogin` opens the dashboard URL with the right `redirect` + `state`
 *  - The localhost callback POST is received and validated
 *    (`startCallbackServer` is exercised with a real `Bun.serve` in the
 *    second test)
 *  - The signInToken is exchanged for a Clerk session via FAPI (mocked)
 *  - `~/.vault/session.json` is persisted with mode 0600 and
 *    `~/.vault/` ends up at mode 0700
 *  - The persisted JSON parses to a `SessionState` with the expected fields
 *
 * What's stubbed (and why):
 *  - `openBrowser`: nothing to verify in a hermetic test
 *  - `exchangeTicketForSession`: that's Clerk's contract; the existing
 *    unit tests in `tests/auth/clerkFapi.test.ts` cover the wire shape.
 *    The scenario only needs the side effect (a `SessionState` to persist).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startCallbackServer } from '../../src/auth/callbackServer'
import { exchangeTicketForSession } from '../../src/auth/clerkFapi'
import { runLogin } from '../../src/commands/login'
import { cleanupTempHome, setupTempHome } from './_helpers'

vi.mock('../../src/auth/openBrowser', () => ({
  openBrowser: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/auth/clerkFapi', () => ({
  exchangeTicketForSession: vi.fn(),
  ClerkSessionExpiredError: class extends Error {},
  cliUserAgent: () => 'cvault-cli/0.1.0 (test)',
}))

let tempHome: string

beforeEach(() => {
  tempHome = setupTempHome('cvault-bootstrap-test-')
})

afterEach(() => {
  cleanupTempHome(tempHome)
})

/**
 * POST to the localhost callback as the dashboard would. Schedules the
 * request asynchronously so `runLogin` can transition from "waiting" to
 * "exchange". Failures bubble up via `runLogin` timing out.
 */
async function postCallback(redirect: string, state: string): Promise<void> {
  const res = await fetch(redirect, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, signInToken: 'sit_e2e_bootstrap' }),
  })
  if (!res.ok) {
    throw new Error(`callback POST returned ${String(res.status)}`)
  }
}

const FIXTURE_SESSION = {
  version: 1 as const,
  clerkSessionId: 'sess_e2e_bootstrap',
  clerkSessionToken: 'long-lived-clerk-jwt',
  convexJwt: 'short-lived-convex-jwt',
  convexJwtExpiry: Math.floor(Date.now() / 1000) + 60,
  frontendApiUrl: 'https://clear-redbird-6.clerk.accounts.dev',
  convexUrl: 'https://beloved-mouse-707.convex.cloud',
  issuedAt: Math.floor(Date.now() / 1000),
}

describe('Scenario #1 — First-machine bootstrap', () => {
  it('persists ~/.vault/session.json with mode 0600 inside ~/.vault/ at mode 0700', async () => {
    // For this test we drive a REAL Bun.serve callback so
    // `startCallbackServer` is exercised end-to-end. The exchange step is
    // still mocked because Clerk's contract isn't under test here.
    vi.mocked(exchangeTicketForSession).mockResolvedValueOnce(FIXTURE_SESSION)

    // Capture the link URL by intercepting `openBrowser` — and use the
    // intercepted URL to POST to the real callback like the dashboard would.
    const { openBrowser } = await import('../../src/auth/openBrowser')
    vi.mocked(openBrowser).mockImplementation((urlStr) => {
      const url = new URL(urlStr)
      const redirect = url.searchParams.get('redirect') ?? ''
      const state = url.searchParams.get('state') ?? ''
      // Send the dashboard's callback POST asynchronously: `runLogin`
      // returns the openBrowser promise to its caller, then awaits the
      // callback server's `result`. So the POST has to be scheduled AFTER
      // we resolve openBrowser, otherwise the server isn't yet awaited.
      // The fire-and-forget pattern is intentional; failures surface via
      // `runLogin` rejecting (timeout) which the test asserts on.
      void postCallback(redirect, state)
      return Promise.resolve()
    })

    await runLogin({
      dashboardUrl: 'https://app.cvault.dev',
      convexUrl: FIXTURE_SESSION.convexUrl,
      frontendApiUrl: FIXTURE_SESSION.frontendApiUrl,
      timeoutMs: 5_000,
    })

    // The exchange action received the captured signInToken.
    expect(exchangeTicketForSession).toHaveBeenCalledOnce()
    const exchangeArgs = vi.mocked(exchangeTicketForSession).mock.calls[0]?.[0]
    expect(exchangeArgs?.signInToken).toBe('sit_e2e_bootstrap')

    // ~/.vault/ exists with mode 0700.
    const vaultDir = join(tempHome, '.vault')
    expect(existsSync(vaultDir)).toBe(true)
    const dirStat = statSync(vaultDir)
    expect(dirStat.mode & 0o777).toBe(0o700)

    // ~/.vault/session.json exists with mode 0600 and parses correctly.
    const sessionPath = join(vaultDir, 'session.json')
    expect(existsSync(sessionPath)).toBe(true)
    const fileStat = statSync(sessionPath)
    expect(fileStat.mode & 0o777).toBe(0o600)

    const parsed = JSON.parse(readFileSync(sessionPath, 'utf8')) as Record<string, unknown>
    expect(parsed.version).toBe(1)
    expect(parsed.clerkSessionId).toBe('sess_e2e_bootstrap')
    expect(parsed.clerkSessionToken).toBe('long-lived-clerk-jwt')
    expect(parsed.convexJwt).toBe('short-lived-convex-jwt')
    expect(typeof parsed.convexJwtExpiry).toBe('number')
    expect(parsed.frontendApiUrl).toBe(FIXTURE_SESSION.frontendApiUrl)
    expect(parsed.convexUrl).toBe(FIXTURE_SESSION.convexUrl)
  })

  it('Bun.serve callback rejects POSTs with the wrong state nonce', async () => {
    // Drive `startCallbackServer` directly to verify the security property
    // that motivated the state nonce: an attacker who guesses the port
    // can't substitute their own signInToken without knowing the state.
    const handle = startCallbackServer({ expectedState: 'state-real', timeoutMs: 5_000 })

    const badRes = await fetch(`http://127.0.0.1:${String(handle.port)}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'state-attacker', signInToken: 'sit_evil' }),
    })
    expect(badRes.status).toBe(400)

    // The handle's result promise must NOT be settled by a bad request.
    // Send the correct one and observe success, then cancel cleanly.
    const goodRes = await fetch(`http://127.0.0.1:${String(handle.port)}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'state-real', signInToken: 'sit_legit' }),
    })
    expect(goodRes.status).toBe(200)
    const result = await handle.result
    expect(result.signInToken).toBe('sit_legit')
    await handle.cancel()
  })
})
