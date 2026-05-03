/**
 * Owner-scoped read of a keyRotationJobs row.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §3.
 */
import { describe, expect, it } from 'vitest'

import { SECOND_IDENTITY, TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'

describe('keyRotationJobs.queries.getJob', () => {
  it('returns the job to its owner', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const inserted = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 0,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    const got = await t.withIdentity(TEST_IDENTITY).query(api.keyRotationJobs.queries.getJob, { jobId: inserted.jobId })
    expect(got).not.toBeNull()
    expect(got?.toVersion).toBe('v2')
  })

  it('returns null for a non-owner', async () => {
    const t = vault()
    const ownerUserId = await seedUser(t, TEST_IDENTITY)
    await seedUser(t, SECOND_IDENTITY)
    const inserted = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId: ownerUserId,
      totalRows: 0,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    const got = await t
      .withIdentity(SECOND_IDENTITY)
      .query(api.keyRotationJobs.queries.getJob, { jobId: inserted.jobId })
    expect(got).toBeNull()
  })
})

describe('keyRotationJobs.queries.getLatestJobForCaller', () => {
  it('returns the most recent job for the caller', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const first = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 0,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    await t.mutation(internal.keyRotationJobs.mutations.markCompleted, { jobId: first.jobId })
    // Wait a millisecond so startedAt differs.
    await new Promise((r) => setTimeout(r, 2))
    const second = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 1,
      fromVersion: 'v2',
      toVersion: 'v3',
    })
    const got = await t.withIdentity(TEST_IDENTITY).query(api.keyRotationJobs.queries.getLatestJobForCaller, {})
    expect(got?._id).toEqual(second.jobId)
  })

  it('returns null when caller has no jobs', async () => {
    const t = vault()
    await seedUser(t)
    const got = await t.withIdentity(TEST_IDENTITY).query(api.keyRotationJobs.queries.getLatestJobForCaller, {})
    expect(got).toBeNull()
  })
})
