/**
 * Scenario #3 — List with usage (`cvault list`).
 *
 * Plan: docs/research/scenario-tests-plan.md §4.3.
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5
 *  (`pollUsage`, `fetchUsageForSub`) + §7 (`cvault list`).
 *
 * What this scenario covers end-to-end:
 *  - Backend has previously cached usage figures on the sub row (the
 *    `pollUsage` cron writes these — we simulate that by pre-seeding the
 *    fake state)
 *  - `runList` reads the user's subs via the typed
 *    `api.subscriptions.queries.listForUser` ref
 *  - `runList` reads `claude-swap --status` to determine which sub is
 *    currently active locally
 *  - The rendered table contains the cached 5h% / 7d% percentages
 *    (rounded per `render/table.ts`)
 *  - The active marker is on the slot that `claude-swap --status` reports
 *
 * What's stubbed:
 *  - `claude-swap --status` (no real subprocess)
 *  - `makeVaultClient` (in-memory FakeVaultClient seeded with usage)
 *
 * Note on usage rounding: `render/table.ts`'s `pct()` does `Math.round`,
 * so 23.5 -> "24%" (banker's rounding diverges from Math.round; 24 is
 * what Math.round produces). 47.0 -> "47%". The unit tests for
 * `render/table.ts` already cover the rounding rule; this scenario
 * asserts the wiring carries the cached numbers through unmolested.
 */
import { api } from '@cvault/convex/api'
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runList } from '../../src/commands/list'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { getActiveAccount } from '../../src/credentials'
import {
  SAMPLE_OAUTH_BLOB,
  cleanupTempHome,
  createFakeVaultClient,
  getCall,
  makeSub,
  refName,
  setupTempHome,
} from './_helpers'

vi.mock('../../src/credentials', () => ({
  getActiveAccount: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

let tempHome: string

beforeEach(() => {
  tempHome = setupTempHome('cvault-list-usage-test-')
})

afterEach(() => {
  cleanupTempHome(tempHome)
})

describe('Scenario #3 — List with usage', () => {
  it('renders cached usage figures and marks the locally-active slot', async () => {
    const fetchedAt = Date.now()
    const sub = await makeSub({
      email: 'a@b.com',
      slot: 1,
      plaintextBlob: SAMPLE_OAUTH_BLOB,
      label: 'primary',
      // Usage figures the backend's `pollUsage` cron would have written.
      usage5h: { pct: 23.5, resetsAt: fetchedAt + 5 * 60 * 60 * 1000, fetchedAt },
      usage7d: { pct: 47.0, resetsAt: fetchedAt + 7 * 24 * 60 * 60 * 1000, fetchedAt },
    })

    const fake = createFakeVaultClient({ subscriptions: [sub] })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce({ email: 'a@b.com' })

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()

    // Dispatch: the typed `listForUser` ref was used.
    expect(fake.query).toHaveBeenCalledOnce()
    expect(refName(getCall(fake.query, 0).ref)).toBe(getFunctionName(api.subscriptions.queries.listForUser))

    const out = captured.join('\n')
    // Email present.
    expect(out).toContain('a@b.com')
    // Label present.
    expect(out).toContain('primary')
    // Usage numbers (Math.round: 23.5 -> 24, 47.0 -> 47).
    expect(out).toContain('24%')
    expect(out).toContain('47%')

    // Active marker on slot 1's row (the asterisk prefix in `render/table.ts`).
    const lines = out.split('\n')
    const aLine = lines.find((l) => l.includes('a@b.com'))
    expect(aLine).toBeDefined()
    expect(aLine).toMatch(/\*\s*1/)
  })

  it('renders subs without usage data (cron has not run yet) gracefully', async () => {
    const sub = await makeSub({
      email: 'no-usage@b.com',
      slot: 2,
      plaintextBlob: SAMPLE_OAUTH_BLOB,
      // Explicitly no usage fields.
      usage5h: undefined,
      usage7d: undefined,
    })
    const fake = createFakeVaultClient({ subscriptions: [sub] })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)
    vi.mocked(getActiveAccount).mockReturnValueOnce(null)

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()
    const out = captured.join('\n')
    expect(out).toContain('no-usage@b.com')
    // Without usage data we expect the dash placeholder per
    // `render/table.ts`'s `pct()`. There must be at least one dash cell on
    // the data row.
    const dataLine = out.split('\n').find((l) => l.includes('no-usage@b.com'))
    expect(dataLine).toMatch(/\s-\s/)
  })

  it('marks no slot active when reading the local active account fails', async () => {
    const sub = await makeSub({
      email: 'offline@b.com',
      slot: 3,
      plaintextBlob: SAMPLE_OAUTH_BLOB,
    })
    const fake = createFakeVaultClient({ subscriptions: [sub] })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)
    vi.mocked(getActiveAccount).mockImplementationOnce(() => {
      throw new Error('keychain read failed')
    })

    const captured: string[] = []
    vi.spyOn(console, 'log').mockImplementation((s: string) => {
      captured.push(s)
    })

    await runList()
    const out = captured.join('\n')
    expect(out).toContain('offline@b.com')
    // No asterisk prefix on the data row when status() failed — still
    // renders the table without an active marker.
    const lines = out.split('\n').filter((l) => l.includes('offline@b.com'))
    expect(lines.length).toBe(1)
    expect(lines[0]).not.toMatch(/^\*/)
  })
})
