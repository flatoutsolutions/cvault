import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * Per-email allowlist. Stored emails are normalized: lowercased + trimmed.
 * Index `byEmail` lets the gate de-dup at insert time and look up exact
 * matches during the auth wrapper / webhook flow.
 *
 * Companion to `allowedEmailDomains`. The gate accepts an email when
 * either (a) its domain matches a domain row OR (b) the lowercased email
 * matches an email row.
 */
export const allowedEmailsSchema = defineTable({
  email: v.string(),
  addedAtMs: v.number(),
  addedByUserId: v.optional(v.id('users')),
}).index('byEmail', ['email'])
