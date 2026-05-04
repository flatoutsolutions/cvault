import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const allowedEmailDomainsSchema = defineTable({
  domain: v.string(),
  addedAtMs: v.number(),
  addedByUserId: v.optional(v.id('users')),
}).index('byDomain', ['domain'])
