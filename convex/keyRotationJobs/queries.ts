/**
 * Owner-scoped read of a keyRotationJobs row. Used by the dashboard to
 * poll progress while a rotation is running.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §3.
 */
import { v } from 'convex/values'

import { authenticatedQuery, getIdentity } from '../utils/auth'

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
    const identity = getIdentity(ctx)
    const job = await ctx.db.get('keyRotationJobs', jobId)
    if (!job) return null
    const owner = await ctx.db.get('users', job.userId)
    if (!owner || owner.externalId !== identity.subject) return null
    return job
  },
})

export const getLatestJobForCaller = authenticatedQuery({
  args: {},
  returns: v.union(jobValidator, v.null()),
  handler: async (ctx) => {
    const identity = getIdentity(ctx)
    const user = await ctx.db
      .query('users')
      .withIndex('byExternalId', (q) => q.eq('externalId', identity.subject))
      .unique()
    if (!user) return null
    const latest = await ctx.db
      .query('keyRotationJobs')
      .withIndex('byUserAndStartedAt', (q) => q.eq('userId', user._id))
      .order('desc')
      .first()
    return latest ?? null
  },
})
