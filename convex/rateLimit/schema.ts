/**
 * Rate-limit token-bucket records.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §12 (rate
 * limiting deferred to v2 broadly; this is a focused per-route limiter
 * for the bulk-extract surface `/api/cli/sync`).
 *
 * One row per `(userId, key)` — `key` is the bucket name, e.g.
 * `'cliSync'`. We model each bucket as a token bucket: `tokens` counts
 * the remaining quota, `windowStart` is the timestamp the current
 * window opened. The mutation that consumes a token refills the bucket
 * (`tokens` reset + `windowStart` advanced) when the window has rolled
 * over.
 */
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const rateLimitSchema = defineTable({
  userId: v.id('users'),
  /** Bucket name. Different routes use different buckets. */
  key: v.string(),
  /** Remaining tokens in the current window. */
  tokens: v.number(),
  /** Wall-clock ms of the current window's start. */
  windowStart: v.number(),
})
  .index('byUserAndKey', ['userId', 'key'])
