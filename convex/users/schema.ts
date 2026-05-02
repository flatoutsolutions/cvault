import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const usersSchema = defineTable({
  externalId: v.string(),
  name: v.string(),
  primaryEmail: v.string(),
  otherEmails: v.array(v.string()),
  imageUrl: v.optional(v.string()),
}).index('byExternalId', ['externalId'])
