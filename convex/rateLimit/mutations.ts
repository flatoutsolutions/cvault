/**
 * Per-user token-bucket rate limiter.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §12.
 *
 * The mutation runs atomically (Convex mutations are serialised
 * transactions), so the read-modify-write sequence on the bucket is
 * race-free across concurrent callers. The HTTP handler / action that
 * needs rate limiting calls `consume` and inspects the result — when
 * `allowed: false`, the caller returns a 429 response with the
 * `retryAfterMs` hint.
 */
import { v } from 'convex/values'

import { internalMutation } from '../_generated/server'

export const consume = internalMutation({
  args: {
    userId: v.id('users'),
    key: v.string(),
    /** Tokens granted per `windowMs`. */
    capacity: v.number(),
    /** Window length in ms (e.g. 3600_000 for "per hour"). */
    windowMs: v.number(),
  },
  returns: v.object({
    allowed: v.boolean(),
    remaining: v.number(),
    /** When the next token will be available; only meaningful when allowed=false. */
    retryAfterMs: v.number(),
  }),
  handler: async (ctx, { userId, key, capacity, windowMs }) => {
    const now = Date.now()
    const existing = await ctx.db
      .query('rateLimit')
      .withIndex('byUserAndKey', (q) => q.eq('userId', userId).eq('key', key))
      .unique()

    // Fresh window if no row or the window rolled over.
    if (!existing || now - existing.windowStart >= windowMs) {
      // Consuming this call leaves capacity-1 tokens.
      const remaining = capacity - 1
      if (existing) {
        await ctx.db.patch('rateLimit', existing._id, {
          tokens: remaining,
          windowStart: now,
        })
      } else {
        await ctx.db.insert('rateLimit', {
          userId,
          key,
          tokens: remaining,
          windowStart: now,
        })
      }
      return { allowed: true, remaining, retryAfterMs: 0 }
    }

    // Same window — check whether tokens are available.
    if (existing.tokens > 0) {
      await ctx.db.patch('rateLimit', existing._id, {
        tokens: existing.tokens - 1,
      })
      return { allowed: true, remaining: existing.tokens - 1, retryAfterMs: 0 }
    }

    // Out of tokens — return when the window resets.
    const retryAfterMs = Math.max(0, existing.windowStart + windowMs - now)
    return { allowed: false, remaining: 0, retryAfterMs }
  },
})
