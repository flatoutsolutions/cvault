import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const organizationsSchema = defineTable({
  externalId: v.string(),
  name: v.string(),
  slug: v.string(),
  imageUrl: v.optional(v.string()),
  membersCount: v.optional(v.number()),
  maxAllowedMemberships: v.number(),
  createdBy: v.optional(v.string()),
})
  .index('byExternalId', ['externalId'])
  .index('bySlug', ['slug'])
