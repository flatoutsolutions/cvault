/**
 * Internal mutations driving the keyRotationJobs lifecycle.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §5.
 *
 * `insertJob` is the single entrypoint for creating a job. It atomically
 * checks for an existing pending/running job for the same user and
 * returns its id instead of inserting a duplicate (A2 fix from the
 * 2026-05-04 review). Without this, two concurrent triggerKeyRotation
 * calls from the same user would both observe "no running job" in
 * separate transactions and both insert — racing the rotation.
 */
import { ConvexError, v } from 'convex/values'

import { internalMutation } from '../_generated/server'

const insertJobResultValidator = v.object({
  jobId: v.id('keyRotationJobs'),
  alreadyRunning: v.boolean(),
})

export const insertJob = internalMutation({
  args: {
    userId: v.id('users'),
    totalRows: v.number(),
    fromVersion: v.optional(v.string()),
    toVersion: v.string(),
  },
  returns: insertJobResultValidator,
  handler: async (ctx, args) => {
    // Atomic check (same transaction as the insert): is there already a
    // pending/running job for this user? Use the byUserAndStartedAt
    // index to bound the scan, then JS-filter on status (small
    // cardinality at single-user scale).
    const existing = await ctx.db
      .query('keyRotationJobs')
      .withIndex('byUserAndStartedAt', (q) => q.eq('userId', args.userId))
      .order('desc')
      .first()
    if (existing && (existing.status === 'pending' || existing.status === 'running')) {
      return { jobId: existing._id, alreadyRunning: true }
    }

    const jobId = await ctx.db.insert('keyRotationJobs', {
      userId: args.userId,
      status: 'pending',
      totalRows: args.totalRows,
      processedRows: 0,
      errorCount: 0,
      startedAt: Date.now(),
      ...(args.fromVersion !== undefined ? { fromVersion: args.fromVersion } : {}),
      toVersion: args.toVersion,
    })
    return { jobId, alreadyRunning: false }
  },
})

export const markRunning = internalMutation({
  args: { jobId: v.id('keyRotationJobs') },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get('keyRotationJobs', jobId)
    if (!job) throw new ConvexError({ code: 'NOT_FOUND', message: 'Job missing' })
    await ctx.db.patch('keyRotationJobs', jobId, { status: 'running' })
    return null
  },
})

export const incrementProgress = internalMutation({
  args: {
    jobId: v.id('keyRotationJobs'),
    deltaProcessed: v.number(),
    deltaErrors: v.number(),
    lastError: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { jobId, deltaProcessed, deltaErrors, lastError }) => {
    const job = await ctx.db.get('keyRotationJobs', jobId)
    if (!job) return null
    const patch: {
      processedRows: number
      errorCount: number
      lastError?: string
    } = {
      processedRows: job.processedRows + deltaProcessed,
      errorCount: job.errorCount + deltaErrors,
    }
    if (lastError !== undefined) patch.lastError = lastError
    await ctx.db.patch('keyRotationJobs', jobId, patch)
    return null
  },
})

export const markCompleted = internalMutation({
  args: { jobId: v.id('keyRotationJobs') },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get('keyRotationJobs', jobId)
    if (!job) return null
    await ctx.db.patch('keyRotationJobs', jobId, { status: 'completed', completedAt: Date.now() })
    return null
  },
})

export const markFailed = internalMutation({
  args: { jobId: v.id('keyRotationJobs'), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { jobId, error }) => {
    const job = await ctx.db.get('keyRotationJobs', jobId)
    if (!job) return null
    await ctx.db.patch('keyRotationJobs', jobId, { status: 'failed', completedAt: Date.now(), lastError: error })
    return null
  },
})
