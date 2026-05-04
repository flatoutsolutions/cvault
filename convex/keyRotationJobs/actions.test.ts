/**
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §5.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { seedSubscription } from '../__scenarios__/_helpers.scenario'
import { SECOND_IDENTITY, TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY
const ORIGINAL_PREVIOUS = process.env.VAULT_AES_KEY_PREVIOUS
const ORIGINAL_VERSION = process.env.VAULT_KEY_VERSION

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 71).toString('base64')
  delete process.env.VAULT_AES_KEY_PREVIOUS
  delete process.env.VAULT_KEY_VERSION
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.VAULT_AES_KEY
  else process.env.VAULT_AES_KEY = ORIGINAL_KEY
  if (ORIGINAL_PREVIOUS === undefined) delete process.env.VAULT_AES_KEY_PREVIOUS
  else process.env.VAULT_AES_KEY_PREVIOUS = ORIGINAL_PREVIOUS
  if (ORIGINAL_VERSION === undefined) delete process.env.VAULT_KEY_VERSION
  else process.env.VAULT_KEY_VERSION = ORIGINAL_VERSION
})

describe('triggerKeyRotation', () => {
  it('no-ops when all rows are already on the current version', async () => {
    const t = vault()
    await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'a@example.com',
      expiresAt: Date.now() + 60_000,
    })
    const result = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    expect(result.totalRows).toBe(0)
  })

  it('rotates rows whose keyVersion mismatches current', async () => {
    const t = vault()
    // Seed one sub under "v1".
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'a@example.com',
      expiresAt: Date.now() + 60_000,
    })
    // Switch to v2 with PREVIOUS pointing at the original key.
    process.env.VAULT_AES_KEY_PREVIOUS = process.env.VAULT_AES_KEY
    process.env.VAULT_AES_KEY = Buffer.alloc(32, 73).toString('base64')
    process.env.VAULT_KEY_VERSION = 'v2'

    const result = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    expect(result.totalRows).toBe(1)

    // The row's keyVersion should now be "v2".
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', seeded.subId))
    expect(after?.keyVersion).toBe('v2')
  })

  it('returns the existing job id when one is already in flight (A2: TOCTOU race)', async () => {
    const t = vault()
    await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'a@example.com',
      expiresAt: Date.now() + 60_000,
    })
    process.env.VAULT_AES_KEY_PREVIOUS = process.env.VAULT_AES_KEY
    process.env.VAULT_AES_KEY = Buffer.alloc(32, 79).toString('base64')
    process.env.VAULT_KEY_VERSION = 'v2'

    const r1 = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    // After r1 completes, the second call observes the completed job and
    // starts a new one (zero rows since rotation already happened).
    const r2 = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    expect(r1.jobId).toBeTruthy()
    expect(r2.jobId).toBeTruthy()
    // Both completed cleanly without overlap (the A2 atomic insertJob
    // guard ensures no two concurrent rotation jobs spawn for the same
    // user even when triggers race).
    expect(r2.totalRows).toBe(0)
  })

  /**
   * Shared-vault doctrine (`convex/utils/users.ts:3-7`): there is one
   * master key encrypting the whole vault. Rotation MUST be vault-wide —
   * any authed allowlisted caller triggering a rotation re-encrypts every
   * row, not just the rows they "own". Pre-fix `listSubsForRotation` took
   * a `userId` arg and scoped the work to that user, so alice's manual
   * rotate left bob's row stuck on the prior key version.
   *
   * Operational implication (flagged to user): a rotation is now globally
   * impactful — clicking "Rotate Key" from the dashboard touches every
   * row in the vault, including subs owned by other co-tenants. Aligns
   * with the shared-vault model but the user-visible ergonomics change
   * (one rotate request = vault-wide work).
   */
  it('rotates rows across all users (vault-wide), not just the caller', async () => {
    const t = vault()
    // Seed alice's sub under v1 (default).
    const alice = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'alice-rotate@example.com',
      expiresAt: Date.now() + 60_000,
    })
    // Seed bob's sub under the same v1 key.
    const bob = await seedSubscription({
      t,
      identity: SECOND_IDENTITY,
      email: 'bob-rotate@example.com',
      expiresAt: Date.now() + 60_000,
    })

    // Rotate the master key to v2.
    process.env.VAULT_AES_KEY_PREVIOUS = process.env.VAULT_AES_KEY
    process.env.VAULT_AES_KEY = Buffer.alloc(32, 83).toString('base64')
    process.env.VAULT_KEY_VERSION = 'v2'

    // Alice clicks "Rotate Key" — under shared-vault she rotates BOTH her
    // and bob's rows. Pre-fix this returned totalRows=1 and only touched alice's.
    const result = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    expect(result.totalRows).toBe(2)

    const aliceAfter = await t.run(async (ctx) => await ctx.db.get('subscriptions', alice.subId))
    const bobAfter = await t.run(async (ctx) => await ctx.db.get('subscriptions', bob.subId))
    expect(aliceAfter?.keyVersion).toBe('v2')
    expect(bobAfter?.keyVersion).toBe('v2')
  })
})
