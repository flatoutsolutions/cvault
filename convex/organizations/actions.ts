import type { OrganizationJSON } from '@clerk/backend'
import { type Validator, v } from 'convex/values'

import { type QueryCtx, internalMutation, query } from '../_generated/server'

export const current = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (identity === null || !identity.orgId) {
      return null
    }
    return await orgByExternalId(ctx, identity.orgId as string)
  },
})

export const upsert = internalMutation({
  args: { data: v.any() as Validator<OrganizationJSON> },
  async handler(ctx, { data }) {
    const orgAttributes = {
      externalId: data.id,
      name: data.name,
      slug: data.slug,
      imageUrl: data.image_url ?? undefined,
      membersCount: data.members_count ?? undefined,
      maxAllowedMemberships: data.max_allowed_memberships,
      createdBy: data.created_by ?? undefined,
    }

    const org = await orgByExternalId(ctx, data.id)
    if (org === null) {
      await ctx.db.insert('organizations', orgAttributes)
    } else {
      await ctx.db.patch('organizations', org._id, orgAttributes)
    }
  },
})

export const remove = internalMutation({
  args: { clerkOrgId: v.string() },
  async handler(ctx, { clerkOrgId }) {
    const org = await orgByExternalId(ctx, clerkOrgId)
    if (org !== null) {
      await ctx.db.delete('organizations', org._id)
    } else {
      console.warn(`Can't delete organization, there is none for Clerk org ID: ${clerkOrgId}`)
    }
  },
})

export async function orgByExternalId(ctx: QueryCtx, externalId: string) {
  return await ctx.db
    .query('organizations')
    .withIndex('byExternalId', (q) => q.eq('externalId', externalId))
    .unique()
}
