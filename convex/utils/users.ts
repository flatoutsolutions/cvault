/**
 * User-lookup helpers.
 *
 * Any authenticated Clerk identity (= you) reads/writes the same vault
 * can read/write any row. We still resolve a `users._id` for audit columns
 * (so `recordActivity` etc. has something to attribute to), but the helper
 * NO LONGER scopes data — it just picks a user row to stamp on writes.
 *
 * Resolution order:
 *   1. The current Clerk identity (if a row exists) — best audit fidelity.
 *   2. Any existing user row — falls back when the Clerk webhook hasn't
 *      fired yet for the signed-in identity but another row exists.
 *   3. Throw — vault has no user rows at all (only happens before the
 *      first webhook delivery on a brand-new deployment).
 */
import { ConvexError } from 'convex/values'

import type { QueryCtx } from '../_generated/server'

export async function getCurrentUserOrThrowFromIdentity(ctx: QueryCtx, externalId: string) {
  const own = await ctx.db
    .query('users')
    .withIndex('byExternalId', (q) => q.eq('externalId', externalId))
    .unique()
  if (own) return own
  const any = await ctx.db.query('users').first()
  if (!any) {
    throw new ConvexError({
      code: 'USER_NOT_FOUND',
      message: 'No user rows in vault. Sign in once to trigger the Clerk webhook, then retry.',
    })
  }
  return any
}

export async function getCurrentUserOrNullFromIdentity(ctx: QueryCtx, externalId: string) {
  const own = await ctx.db
    .query('users')
    .withIndex('byExternalId', (q) => q.eq('externalId', externalId))
    .unique()
  if (own) return own
  return await ctx.db.query('users').first()
}
