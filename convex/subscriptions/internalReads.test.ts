/**
 * Spec: §5 (queries) + §11 (testing).
 *
 * `findExpiringSubs` is the cron's gateway for proactive token refresh.
 * The original implementation called `withIndex('byExpiry', q => q.lt(...))`,
 * which scans the index from the lowest-historical `expiresAt` up to the
 * cutoff. At realistic scale that pulls in long-tombstoned rows whose
 * `removedAt` filter happens client-side after `.collect()`.
 *
 * Track B item 10 (perf): bound the scan window to a realistic recovery
 * range. Anthropic refresh tokens are valid for ~30d; a row whose access
 * token expired more than `RECOVERABLE_LOOKBACK_MS` ago is unlikely to
 * be refreshable anyway, so excluding it from the scan is safe and
 * dramatically tightens the index range we read.
 *
 * What this test asserts:
 *  - The query still returns rows in `[now - lookback, cutoff]`
 *  - Rows whose `expiresAt` is below the lookback floor are excluded
 *    (the perf win — they would otherwise be wastefully scanned)
 *  - Soft-removed rows are still excluded from the result
 *  - The query continues to use the existing `byExpiry` index, with a
 *    range expression that includes both lower and upper bounds
 */
import { describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'
import { findExpiringSubs } from './internalReads'

async function seedSub(t: ReturnType<typeof vault>, opts: { email: string; expiresAt: number; removedAt?: number }) {
  const userId = await seedUser(t, {
    subject: TEST_IDENTITY.subject,
    name: TEST_IDENTITY.name,
    email: TEST_IDENTITY.email,
  }).catch(async () => {
    // Re-using the same user across calls — `seedUser` would try to
    // double-insert. Look up the existing one instead.
    return await t.run(async (ctx) => {
      const existing = await ctx.db
        .query('users')
        .withIndex('byExternalId', (q) => q.eq('externalId', TEST_IDENTITY.subject))
        .unique()
      if (!existing) throw new Error('seedUser raced')
      return existing._id
    })
  })

  return await t.run(async (ctx) => {
    return await ctx.db.insert('subscriptions', {
      userId,
      email: opts.email,
      slot: 1,
      ciphertext: new ArrayBuffer(8),
      nonce: new ArrayBuffer(12),
      expiresAt: opts.expiresAt,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
      lastRefreshedAt: Date.now(),
      ...(opts.removedAt !== undefined ? { removedAt: opts.removedAt } : {}),
    })
  })
}

describe('subscriptions.internalReads.findExpiringSubs', () => {
  it('returns subs whose expiresAt is in (now - lookback, now + withinMs)', async () => {
    const t = vault()
    const now = Date.now()

    // In window: expires in 5 min — should be returned.
    const inWindow = await seedSub(t, {
      email: 'in-window@example.com',
      expiresAt: now + 5 * 60 * 1000,
    })
    // In window (recently expired, refresh token still valid): expired 2 min ago
    const recentlyExpired = await seedSub(t, {
      email: 'recently-expired@example.com',
      expiresAt: now - 2 * 60 * 1000,
    })
    // Out of window (far future): expires in 24h — should NOT be returned.
    await seedSub(t, {
      email: 'far-future@example.com',
      expiresAt: now + 24 * 60 * 60 * 1000,
    })
    // Out of window (ancient — refresh token long dead): expired 60 days ago
    await seedSub(t, {
      email: 'ancient@example.com',
      expiresAt: now - 60 * 24 * 60 * 60 * 1000,
    })
    // In window numerically but soft-removed → must NOT appear.
    await seedSub(t, {
      email: 'gone@example.com',
      expiresAt: now + 1 * 60 * 1000,
      removedAt: now - 1000,
    })

    const result = await t.query(internal.subscriptions.internalReads.findExpiringSubs, {
      withinMs: 15 * 60 * 1000,
    })

    const ids = result.map((r) => r.subId).sort()
    expect(ids).toEqual([inWindow, recentlyExpired].sort())
  })

  it('uses withIndex("byExpiry") with a bounded range, not a full scan', async () => {
    /**
     * Lightweight unit assertion that the query body invokes
     * `.withIndex('byExpiry', ...)` with a range expression that
     * includes BOTH a lower bound (gt/gte) and an upper bound (lt/lte).
     *
     * We exercise the handler against a stub `db` and capture the
     * range function calls; this guards against a regression to the
     * unbounded `q.lt(...)` form even if no rows fall outside it
     * during normal test data.
     */
    const recordedRangeOps: Array<{ op: string; field: string; value: unknown }> = []
    const rangeQ = {
      gt: vi.fn((field: string, value: unknown) => {
        recordedRangeOps.push({ op: 'gt', field, value })
        return rangeQ
      }),
      gte: vi.fn((field: string, value: unknown) => {
        recordedRangeOps.push({ op: 'gte', field, value })
        return rangeQ
      }),
      lt: vi.fn((field: string, value: unknown) => {
        recordedRangeOps.push({ op: 'lt', field, value })
        return rangeQ
      }),
      lte: vi.fn((field: string, value: unknown) => {
        recordedRangeOps.push({ op: 'lte', field, value })
        return rangeQ
      }),
      eq: vi.fn(),
    }
    const queryStub = {
      withIndex: vi.fn((indexName: string, fn: (q: typeof rangeQ) => typeof rangeQ) => {
        // Drive the predicate so the test sees what the handler asks for.
        fn(rangeQ)
        return { collect: () => Promise.resolve([]) }
      }),
    }
    const ctxStub = {
      db: { query: vi.fn(() => queryStub) },
    }

    // The internalQuery's `handler` is exposed as `_handler` by the
    // convex/server wrapper. We invoke it directly with our stub ctx
    // because we're asserting on dispatch shape, not on data flow.
    type InternalQueryWithHandler = {
      _handler: (ctx: unknown, args: { withinMs: number }) => Promise<unknown>
    }
    const handler = (findExpiringSubs as unknown as InternalQueryWithHandler)._handler
    if (typeof handler !== 'function') {
      throw new Error('findExpiringSubs._handler not exposed; convex/server internals changed')
    }

    await handler(ctxStub, { withinMs: 15 * 60 * 1000 })

    expect(queryStub.withIndex).toHaveBeenCalledWith('byExpiry', expect.any(Function))

    const lowerBound = recordedRangeOps.find((r) => r.op === 'gt' || r.op === 'gte')
    const upperBound = recordedRangeOps.find((r) => r.op === 'lt' || r.op === 'lte')
    expect(lowerBound).toBeDefined()
    expect(lowerBound?.field).toBe('expiresAt')
    expect(upperBound).toBeDefined()
    expect(upperBound?.field).toBe('expiresAt')
  })
})
