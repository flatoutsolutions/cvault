import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const usersSchema = defineTable({
  externalId: v.string(),
  name: v.string(),
  primaryEmail: v.string(),
  otherEmails: v.array(v.string()),
  imageUrl: v.optional(v.string()),
}).index('byExternalId', ['externalId'])

/**
 * Validator for a `users` row as returned to the dashboard. Mirrors the
 * `usersSchema` table fields exactly (plus the system fields `_id` and
 * `_creationTime` Convex appends to every row). Defined alongside the
 * table schema so consumers (queries, internal queries returning rows)
 * stay in sync with the stored shape — the pre-fix `query()` had no
 * `returns` validator, so any handler regression silently leaked
 * misshaped data to clients.
 */
export const userRowValidator = v.object({
  _id: v.id('users'),
  _creationTime: v.number(),
  externalId: v.string(),
  name: v.string(),
  primaryEmail: v.string(),
  otherEmails: v.array(v.string()),
  imageUrl: v.optional(v.string()),
})
