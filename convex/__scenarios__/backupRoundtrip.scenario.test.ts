/**
 * Scenario: backup export → soft-remove → import → restored sub.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §9.
 *
 * Story:
 *   1. Seed user A with 2 subs.
 *   2. exportEncryptedBackup({ passphrase }) → save bundle.
 *   3. Soft-remove both subs (simulate disaster).
 *   4. importEncryptedBackup({ passphrase, bundleBase64 }) → assert
 *      restoredCount === 2.
 *   5. Assert subs are back, encrypted under server's current key,
 *      decrypt cleanly via pullForSwitch.
 *
 * Variants:
 *   - Wrong passphrase → restoredCount === 0 + clear error.
 *   - Bundle from user A imported by user B does NOT leak A's
 *     credentials onto B (separation enforced by import using caller's
 *     externalId).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import { seedSubscription, withVaultKey } from './_helpers.scenario'

const KEY_FILL = 97

let keyHandle: ReturnType<typeof withVaultKey>

beforeEach(() => {
  keyHandle = withVaultKey(KEY_FILL)
})

afterEach(() => {
  keyHandle.restore()
})

describe('scenario: encrypted backup round-trip', () => {
  it('exports, soft-removes, re-imports, restores cleanly', async () => {
    const t = vault()
    await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'r1@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'r2@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })

    const exported = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    expect(exported.accountCount).toBe(2)

    // Disaster: remove both subs.
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, { email: 'r1@example.com' })
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, { email: 'r2@example.com' })

    const beforeRestore = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(beforeRestore).toHaveLength(0)

    const restored = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.importEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
      bundleBase64: exported.contentBase64,
    })
    expect(restored.restoredCount).toBe(2)

    const afterRestore = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(afterRestore.map((s) => s.email).sort()).toEqual(['r1@example.com', 'r2@example.com'])

    // pullForSwitch must work on a restored sub.
    const pulled = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'r1@example.com',
    })
    expect(pulled.plaintextBlob.length).toBeGreaterThan(0)
  })

  it('wrong passphrase: rejects with BACKUP_BAD_PASSPHRASE and does NOT restore anything', async () => {
    const t = vault()
    await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'badpass@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    const exported = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    await t
      .withIdentity(TEST_IDENTITY)
      .mutation(api.subscriptions.mutations.softRemove, { email: 'badpass@example.com' })

    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.backup.actions.importEncryptedBackup, {
        passphrase: 'wrong-passphrase-also-long',
        bundleBase64: exported.contentBase64,
      })
    ).rejects.toThrow(/passphrase|decryption/i)

    // Vault was NOT mutated by the failed import (A5 atomicity).
    const after = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(after).toHaveLength(0)
  })

  it("A3 cross-user import: user B importing A's bundle restores into B's account (no leak across users)", async () => {
    const t = vault()
    // Seed user A with the original sub.
    await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'shared@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    const aBundle = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })

    // User B is a separate identity. They import A's bundle: the
    // restored row should land under B's userId, NOT A's.
    const bIdentity = {
      subject: 'user_test_charlie',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_charlie',
      name: 'Charlie',
      email: 'charlie@example.com',
    }
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: bIdentity.subject,
        name: bIdentity.name,
        primaryEmail: bIdentity.email,
        otherEmails: [],
      })
    })

    const restored = await t.withIdentity(bIdentity).action(api.backup.actions.importEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
      bundleBase64: aBundle.contentBase64,
    })
    expect(restored.restoredCount).toBe(1)

    // B's account now has the sub.
    const bSubs = await t.withIdentity(bIdentity).query(api.subscriptions.queries.listForUser, {})
    expect(bSubs.map((s) => s.email)).toEqual(['shared@example.com'])

    // A's account still has the original sub (unchanged).
    const aSubs = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(aSubs.map((s) => s.email)).toEqual(['shared@example.com'])
  })
})
