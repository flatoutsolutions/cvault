/**
 * Scenario — `refreshExpiringTokens` cron is REMOVED in v1 (audit fix #5).
 *
 * Background:
 *   Anthropic rotates the refresh token on EVERY refresh
 *   (docs/research/anthropic-oauth-refresh.md). When a user runs Claude
 *   Code locally, the laptop's Keychain rotates its RT but the vault
 *   doesn't see that rotation until the next `cvault refresh` /
 *   `cvault switch` ferries the new state up. A cron driving Anthropic
 *   refresh from the vault's stored RT therefore loses against any
 *   recent local rotation: Anthropic answers `invalid_grant`, the cron
 *   marks the row `reloginRequired`, and the user is falsely flagged.
 *
 *   `cvault refresh` (interactive, on-machine) has access to `localState`
 *   from the Keychain and can call `adoptLocalState` to win this race.
 *   The cron has no `localState` channel — structurally cannot win.
 *   Per spec §2 ("pull-on-use only in v1") the cron contradicts intent.
 *
 *   Decision: drop the cron entirely.  `pollUsage` (read-only,
 *   side-effect-free) stays.
 *
 * What this scenario asserts:
 *   1. The internal action `subscriptions.crons.refreshExpiringTokens`
 *      is no longer exported (removed alongside its `findExpiringSubs`
 *      query and the `crons.interval(...)` registration).
 *   2. The remaining `pollUsage` cron is still scheduled at its
 *      original cadence so usage telemetry keeps flowing.
 *
 * If a future commit re-adds the cron without resolving the localState
 * gap, this test breaks immediately — making the regression visible at
 * code-review time rather than in production audit logs.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('Scenario — refreshExpiringTokens cron is removed in v1', () => {
  it('crons.ts source does not register the refresh-expiring-tokens job', () => {
    // Source-file check: directly verify the file doesn't register the
    // dropped cron. This is durable across Convex SDK refactors — we
    // don't rely on the runtime shape of the `Crons` object, just the
    // textual contents of the file we control.
    const cronsSrc = readFileSync(new URL('../../crons.ts', import.meta.url), 'utf8')
    expect(cronsSrc).not.toMatch(/refreshExpiringTokens|refresh expiring oauth tokens/)
    // pollUsage MUST still be registered (usage telemetry keeps flowing).
    expect(cronsSrc).toMatch(/pollUsage|poll anthropic usage/)
  })

  it('the action `internal.subscriptions.crons.refreshExpiringTokens` is no longer exported', async () => {
    const cronModule = (await import('../../subscriptions/crons')) as Record<string, unknown>
    // The export must be gone — we assert on the module surface so a
    // future caller that tries to schedule it manually fails at import.
    expect(cronModule.refreshExpiringTokens).toBeUndefined()
    // pollUsage stays.
    expect(cronModule.pollUsage).toBeDefined()
  })

  it('the internal query `findExpiringSubs` is no longer exported', async () => {
    const internalReadsModule = (await import('../../subscriptions/internalReads')) as Record<string, unknown>
    expect(internalReadsModule.findExpiringSubs).toBeUndefined()
    // listAllActiveSubIds stays — pollUsage uses it.
    expect(internalReadsModule.listAllActiveSubIds).toBeDefined()
  })
})
