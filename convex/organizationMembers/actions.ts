import type { OrganizationMembershipJSON } from '@clerk/backend'
import { type Validator, v } from 'convex/values'

import { type QueryCtx, internalMutation } from '../_generated/server'
import { authenticatedQuery } from '../utils/auth'

export const listByOrg = authenticatedQuery({
  args: { orgExternalId: v.string() },
  handler: async (ctx, { orgExternalId }) => {
    return await ctx.db
      .query('organizationMembers')
      .withIndex('byOrgExternalId', (q) => q.eq('orgExternalId', orgExternalId))
      .collect()
  },
})

export const listByUser = authenticatedQuery({
  args: { userExternalId: v.string() },
  handler: async (ctx, { userExternalId }) => {
    return await ctx.db
      .query('organizationMembers')
      .withIndex('byUserExternalId', (q) => q.eq('userExternalId', userExternalId))
      .collect()
  },
})

export const upsert = internalMutation({
  args: { data: v.any() as Validator<OrganizationMembershipJSON> },
  async handler(ctx, { data }) {
    const memberAttributes = {
      externalId: data.id,
      orgExternalId: data.organization.id,
      userExternalId: data.public_user_data.user_id,
      role: data.role,
    }

    const member = await memberByExternalId(ctx, data.id)
    if (member === null) {
      await ctx.db.insert('organizationMembers', memberAttributes)
    } else {
      await ctx.db.patch('organizationMembers', member._id, memberAttributes)
    }
  },
})

export const remove = internalMutation({
  args: { data: v.any() as Validator<OrganizationMembershipJSON> },
  async handler(ctx, { data }) {
    const member = await memberByExternalId(ctx, data.id)
    if (member !== null) {
      await ctx.db.delete('organizationMembers', member._id)
    } else {
      console.warn(`Can't delete membership, there is none for Clerk membership ID: ${data.id}`)
    }
  },
})

async function memberByExternalId(ctx: QueryCtx, externalId: string) {
  return await ctx.db
    .query('organizationMembers')
    .withIndex('byExternalId', (q) => q.eq('externalId', externalId))
    .unique()
}
