/**
 * Shared-vault reads of keyRotationJobs.
 *
 * Doctrine: any authenticated, allowlisted Clerk identity can read every
 * key-rotation job in the vault — these rows are operational/admin data,
 * not user-private. Reads MUST NOT scope visibility by `userId`. Writes
 * still stamp `userId` for audit (handled in mutations.ts).
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §3.
 */
import { describe, expect, it } from 'vitest'

import { SECOND_IDENTITY, TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'

describe('keyRotationJobs.queries.getJob', () => {
  it('returns the job to any authenticated caller (shared vault)', async () => {
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

  it('returns another user’s job to a different authenticated caller (cross-user visibility)', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    await seedUser(t, SECOND_IDENTITY)
    const aliceJob = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId: aliceId,
      totalRows: 7,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    // Bob authenticates and reads alice's job — must see it.
    const got = await t
      .withIdentity(SECOND_IDENTITY)
      .query(api.keyRotationJobs.queries.getJob, { jobId: aliceJob.jobId })
    expect(got).not.toBeNull()
    expect(got?.userId).toEqual(aliceId)
    expect(got?.totalRows).toBe(7)
  })
})

describe('keyRotationJobs.queries.listJobs', () => {
  it('returns every rotation job across users, newest first', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    const bobId = await seedUser(t, SECOND_IDENTITY)

    const aliceJob = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId: aliceId,
      totalRows: 1,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    // Wait so startedAt timestamps are distinct + ordered.
    await new Promise((r) => setTimeout(r, 2))
    const bobJob = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId: bobId,
      totalRows: 2,
      fromVersion: 'v1',
      toVersion: 'v2',
    })

    // Alice authenticates and lists — must see BOTH her own + bob's job.
    const list = await t.withIdentity(TEST_IDENTITY).query(api.keyRotationJobs.queries.listJobs, {})
    const ids = list.map((j) => j._id)
    expect(ids).toContain(aliceJob.jobId)
    expect(ids).toContain(bobJob.jobId)
    // Newest first: bob's job was inserted later → it must come first.
    expect(ids[0]).toEqual(bobJob.jobId)
    expect(ids[1]).toEqual(aliceJob.jobId)
  })

  it('returns an empty array when no jobs exist', async () => {
    const t = vault()
    await seedUser(t)
    const list = await t.withIdentity(TEST_IDENTITY).query(api.keyRotationJobs.queries.listJobs, {})
    expect(list).toEqual([])
  })
})
