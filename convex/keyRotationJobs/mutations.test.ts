/**
 * Internal mutations driving the keyRotationJobs lifecycle.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §3 + §5.
 */
import { describe, expect, it } from 'vitest'

import { seedUser, vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'

describe('keyRotationJobs mutations (internal)', () => {
  it('insertJob creates a pending row and returns its id', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const result = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 5,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    const row = await t.run(async (ctx) => await ctx.db.get('keyRotationJobs', result.jobId))
    expect(row?.status).toBe('pending')
    expect(row?.totalRows).toBe(5)
    expect(row?.processedRows).toBe(0)
    expect(row?.errorCount).toBe(0)
  })

  it('markRunning flips status to running', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const result = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 1,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    await t.mutation(internal.keyRotationJobs.mutations.markRunning, { jobId: result.jobId })
    const row = await t.run(async (ctx) => await ctx.db.get('keyRotationJobs', result.jobId))
    expect(row?.status).toBe('running')
  })

  it('incrementProgress patches counters', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const result = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 10,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    await t.mutation(internal.keyRotationJobs.mutations.incrementProgress, {
      jobId: result.jobId,
      deltaProcessed: 3,
      deltaErrors: 1,
    })
    const row = await t.run(async (ctx) => await ctx.db.get('keyRotationJobs', result.jobId))
    expect(row?.processedRows).toBe(3)
    expect(row?.errorCount).toBe(1)
  })

  it('markCompleted sets completedAt + status', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const result = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 0,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    await t.mutation(internal.keyRotationJobs.mutations.markCompleted, { jobId: result.jobId })
    const row = await t.run(async (ctx) => await ctx.db.get('keyRotationJobs', result.jobId))
    expect(row?.status).toBe('completed')
    expect(row?.completedAt).toBeGreaterThan(0)
  })

  it('insertJob returns existing pending job id when one is in flight (A2: TOCTOU race fix)', async () => {
    // Per the parallel review's A2: an atomic existence-check-and-insert
    // prevents two concurrent triggerKeyRotation calls from spawning two
    // racing rotation jobs for the same user.
    const t = vault()
    const userId = await seedUser(t)
    const first = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 5,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    expect(first.alreadyRunning).toBe(false)

    // Second insert MUST observe the first pending job and return its id
    // rather than inserting a fresh row.
    const second = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 5,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    expect(second.jobId).toEqual(first.jobId)
    expect(second.alreadyRunning).toBe(true)

    // Once the first completes, a new insert creates a fresh job.
    await t.mutation(internal.keyRotationJobs.mutations.markCompleted, { jobId: first.jobId })
    const third = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 5,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    expect(third.jobId).not.toEqual(first.jobId)
    expect(third.alreadyRunning).toBe(false)
  })
})
