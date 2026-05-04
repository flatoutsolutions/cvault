import type { UserJSON } from '@clerk/backend'
import { type Validator, v } from 'convex/values'

import { type QueryCtx, internalMutation, internalQuery, query } from '../_generated/server'
import { userRowValidator } from './schema'

export const current = query({
  args: {},
  returns: v.union(userRowValidator, v.null()),
  handler: async (ctx) => {
    return await getCurrentUser(ctx)
  },
})

export const upsert = internalMutation({
  args: { data: v.any() as Validator<UserJSON> },
  async handler(ctx, { data }) {
    const primaryEmailObj = data.email_addresses.find((e) => e.id === data.primary_email_address_id)
    const primaryEmail = primaryEmailObj?.email_address ?? ''
    const otherEmails = data.email_addresses
      .filter((e) => e.id !== data.primary_email_address_id)
      .map((e) => e.email_address)

    const userAttributes = {
      externalId: data.id,
      name: `${data.first_name ?? ''} ${data.last_name ?? ''}`.trim(),
      primaryEmail,
      otherEmails,
      imageUrl: data.image_url ?? undefined,
    }

    const user = await userByExternalId(ctx, data.id)
    if (user === null) {
      await ctx.db.insert('users', userAttributes)
    } else {
      await ctx.db.patch('users', user._id, userAttributes)
    }
  },
})

export const remove = internalMutation({
  args: { clerkUserId: v.string() },
  async handler(ctx, { clerkUserId }) {
    const user = await userByExternalId(ctx, clerkUserId)
    if (user !== null) {
      await ctx.db.delete('users', user._id)
    } else {
      console.warn(`Can't delete user, there is none for Clerk user ID: ${clerkUserId}`)
    }
  },
})

export async function getCurrentUserOrThrow(ctx: QueryCtx) {
  const userRecord = await getCurrentUser(ctx)
  if (!userRecord) throw new Error("Can't get current user")
  return userRecord
}

export async function getCurrentUser(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity()
  if (identity === null) {
    return null
  }
  return await userByExternalId(ctx, identity.subject)
}

async function userByExternalId(ctx: QueryCtx, externalId: string) {
  return await ctx.db
    .query('users')
    .withIndex('byExternalId', (q) => q.eq('externalId', externalId))
    .unique()
}

/**
 * Internal query used by Node actions (which can't query the DB directly)
 * to resolve a Clerk externalId to a `users._id`. Returns null if the
 * Clerk webhook hasn't yet inserted the user row. Callers that need to
 * write a related row (e.g. `machineActivity`) should treat null as
 * "skip the audit row" rather than failing the operation.
 */
export const getIdByExternalId = internalQuery({
  args: { externalId: v.string() },
  returns: v.union(v.id('users'), v.null()),
  handler: async (ctx, { externalId }) => {
    const user = await userByExternalId(ctx, externalId)
    return user === null ? null : user._id
  },
})
