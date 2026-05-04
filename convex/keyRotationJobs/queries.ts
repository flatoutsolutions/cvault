/**
 * Shared-vault reads of keyRotationJobs.
 *
 * cvault is a shared vault: any authenticated, allowlisted Clerk identity
 * (see `convex/utils/users.ts`) can read every key-rotation job. These
 * rows are operational/admin data — knowing that "alice triggered a
 * rotation 3h ago" is not user-private. Therefore reads do NOT scope by
 * `userId`. The `userId` column is still returned so the dashboard can
 * label each entry ("Rotation by alice").
 *
 * Writes (in `mutations.ts`) still stamp `userId` for audit. The
 * `byUserAndStartedAt` index remains in place because the per-user
 * "alreadyRunning?" check at insert time is a write-side concurrency
 * gate, not a read-visibility gate.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §3.
 */
import { v } from 'convex/values'

import { authenticatedQuery } from '../utils/auth'

const jobValidator = v.object({
  _id: v.id('keyRotationJobs'),
  _creationTime: v.number(),
  userId: v.id('users'),
  status: v.union(v.literal('pending'), v.literal('running'), v.literal('completed'), v.literal('failed')),
  totalRows: v.number(),
  processedRows: v.number(),
  errorCount: v.number(),
  startedAt: v.number(),
  completedAt: v.optional(v.number()),
  fromVersion: v.optional(v.string()),
  toVersion: v.string(),
  lastError: v.optional(v.string()),
})

export const getJob = authenticatedQuery({
  args: { jobId: v.id('keyRotationJobs') },
  returns: v.union(jobValidator, v.null()),
  handler: async (ctx, { jobId }) => {
    // Shared vault: any authenticated caller may read any job. We do
    // not gate visibility on the caller owning the row.
    return (await ctx.db.get('keyRotationJobs', jobId)) ?? null
  },
})

/**
 * Every rotation job in the vault, newest first.
 *
 * Used by the dashboard to render the rotation history surface. Returns
 * the full job rows (including `userId`) so the UI can label each entry
 * with the user who triggered it.
 *
 * Sort order: `startedAt` desc via the `byStartedAt` index on the
 * `keyRotationJobs` table. The index is global (no equality prefix) so
 * the descending walk visits every job in chronological order without
 * scanning the whole table.
 */
export const listJobs = authenticatedQuery({
  args: {},
  returns: v.array(jobValidator),
  handler: async (ctx) => {
    return await ctx.db.query('keyRotationJobs').withIndex('byStartedAt').order('desc').collect()
  },
})
