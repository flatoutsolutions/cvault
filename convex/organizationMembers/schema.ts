import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const organizationMembersSchema = defineTable({
  externalId: v.string(),
  orgExternalId: v.string(),
  userExternalId: v.string(),
  role: v.string(),
})
  .index('byExternalId', ['externalId'])
  .index('byOrgExternalId', ['orgExternalId'])
  .index('byUserExternalId', ['userExternalId'])
  .index('byOrgAndUser', ['orgExternalId', 'userExternalId'])
