/**
 * Scenario: end-to-end key rotation.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §9.
 *
 * Story:
 *   1. Seed user with 3 subs encrypted under "v1".
 *   2. Set VAULT_AES_KEY_PREVIOUS = old, VAULT_AES_KEY = new,
 *      VAULT_KEY_VERSION = "v2".
 *   3. Call triggerKeyRotation → wait for the job to complete.
 *   4. Assert all 3 rows now have keyVersion === "v2".
 *   5. Assert pullForSwitch still works (proves the round-trip is healthy
 *      under the new key).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import { seedSubscription, withVaultKey } from './_helpers.scenario'

const KEY_FILL = 91

let keyHandle: ReturnType<typeof withVaultKey>
const ORIGINAL_PREVIOUS = process.env.VAULT_AES_KEY_PREVIOUS
const ORIGINAL_VERSION = process.env.VAULT_KEY_VERSION

beforeEach(() => {
  keyHandle = withVaultKey(KEY_FILL)
  delete process.env.VAULT_AES_KEY_PREVIOUS
  delete process.env.VAULT_KEY_VERSION
})

afterEach(() => {
  keyHandle.restore()
  if (ORIGINAL_PREVIOUS === undefined) delete process.env.VAULT_AES_KEY_PREVIOUS
  else process.env.VAULT_AES_KEY_PREVIOUS = ORIGINAL_PREVIOUS
  if (ORIGINAL_VERSION === undefined) delete process.env.VAULT_KEY_VERSION
  else process.env.VAULT_KEY_VERSION = ORIGINAL_VERSION
})

describe('scenario: rotate encryption key end-to-end', () => {
  it('re-wraps every sub and pullForSwitch still works under the new key', async () => {
    const t = vault()
    // Seed three subs under v1.
    const a = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'a@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    const b = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'b@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    const c = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'c@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })

    // All three rows should currently be on v1.
    for (const seed of [a, b, c]) {
      const row = await t.run(async (ctx) => await ctx.db.get('subscriptions', seed.subId))
      expect(row?.keyVersion).toBe('v1')
    }

    // Rotate env vars: PREVIOUS = v1's key; new key = v2.
    process.env.VAULT_AES_KEY_PREVIOUS = process.env.VAULT_AES_KEY
    process.env.VAULT_AES_KEY = Buffer.alloc(32, 92).toString('base64')
    process.env.VAULT_KEY_VERSION = 'v2'

    const result = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    expect(result.totalRows).toBe(3)
    expect(result.alreadyRunning).toBe(false)

    // Every row's keyVersion should now be "v2".
    for (const seed of [a, b, c]) {
      const row = await t.run(async (ctx) => await ctx.db.get('subscriptions', seed.subId))
      expect(row?.keyVersion).toBe('v2')
    }

    // The job row itself should be `completed` with no errors.
    const job = await t.withIdentity(TEST_IDENTITY).query(api.keyRotationJobs.queries.getJob, { jobId: result.jobId })
    expect(job?.status).toBe('completed')
    expect(job?.errorCount).toBe(0)
    expect(job?.processedRows).toBe(3)
    expect(job?.toVersion).toBe('v2')

    // pullForSwitch must still be able to decrypt under the new key —
    // this proves the round-trip is healthy.
    const pulled = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'a@example.com',
    })
    expect(pulled.email).toBe('a@example.com')
    expect(pulled.plaintextBlob.length).toBeGreaterThan(0)
  })

  it('idempotent: a second triggerKeyRotation no-ops every row that is already on the target', async () => {
    const t = vault()
    await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'a@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })

    process.env.VAULT_AES_KEY_PREVIOUS = process.env.VAULT_AES_KEY
    process.env.VAULT_AES_KEY = Buffer.alloc(32, 93).toString('base64')
    process.env.VAULT_KEY_VERSION = 'v2'

    const first = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    expect(first.totalRows).toBe(1)

    // Second call — every row is already on v2; rotation finds zero work.
    const second = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    expect(second.totalRows).toBe(0)
  })
})
