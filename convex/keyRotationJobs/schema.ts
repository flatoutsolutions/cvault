/**
 * Tracks an in-flight or completed key-rotation job per user.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §3 + §5.
 *
 * The dashboard polls this table at 1s intervals while a rotation runs
 * to render progress (`processedRows` / `totalRows`) and surfaces
 * `errorCount` on completion so the operator can investigate any rows
 * the rotation skipped.
 *
 * Indexes:
 *   - `byUserAndStartedAt` — used at write time by `insertJob` to detect
 *     an existing pending/running rotation for the same user and dedupe
 *     concurrent triggers (A2 race fix). Read-side visibility is no
 *     longer gated on `userId`, so this index is a write-side
 *     concurrency primitive rather than a read filter.
 *   - `byStartedAt` — global descending walk used by `listJobs` to render
 *     the cross-user rotation history surface. Adding a new index is a
 *     zero-downtime schema change.
 */
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const keyRotationJobsSchema = defineTable({
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
  .index('byUserAndStartedAt', ['userId', 'startedAt'])
  .index('byStartedAt', ['startedAt'])
