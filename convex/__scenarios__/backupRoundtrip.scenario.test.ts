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

  it('A3 refuse-overwrite: importing into a vault that already has a live row for the same email throws BACKUP_WOULD_OVERWRITE and does NOT mutate the live row', async () => {
    // Under shared-vault doctrine + global-byEmail dedupe, a live row
    // for `shared@example.com` is unique vault-wide. An import that
    // would silently rotate that ciphertext is surprising to operators
    // running disaster recovery on a live vault. The action refuses
    // upfront (see `convex/backup/actions.ts:278-296`).
    const t = vault()
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'shared@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    const aBundle = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })

    // Snapshot the existing row's ciphertext so we can prove the failed
    // import did NOT touch it.
    const beforeRow = await t.run(async (ctx) => ctx.db.get('subscriptions', seeded.subId))
    if (!beforeRow) throw new Error('seeded row missing pre-import')
    const beforeCipher = Buffer.from(beforeRow.ciphertext).toString('base64')

    const bIdentity = {
      subject: 'user_test_charlie',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_charlie',
      name: 'Charlie',
      email: 'charlie@flatout.solutions',
    }
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: bIdentity.subject,
        name: bIdentity.name,
        primaryEmail: bIdentity.email,
        otherEmails: [],
      })
    })

    await expect(
      t.withIdentity(bIdentity).action(api.backup.actions.importEncryptedBackup, {
        passphrase: 'correcthorsebatterystaple',
        bundleBase64: aBundle.contentBase64,
      })
    ).rejects.toThrow(/BACKUP_WOULD_OVERWRITE|overwrite/i)

    // Vault still has exactly one row for that email. Owner unchanged.
    // Ciphertext unchanged. The action's refuse-overwrite is atomic.
    const allSubs = await t.withIdentity(bIdentity).query(api.subscriptions.queries.list, {})
    expect(allSubs.filter((s) => s.email === 'shared@example.com')).toHaveLength(1)
    const surviving = allSubs.find((s) => s.email === 'shared@example.com')
    if (!surviving) throw new Error('row vanished — refuse-overwrite was not atomic')
    expect(surviving.userId).toBe(seeded.userId)
    const afterRow = await t.run(async (ctx) => ctx.db.get('subscriptions', seeded.subId))
    if (!afterRow) throw new Error('row vanished post-import')
    const afterCipher = Buffer.from(afterRow.ciphertext).toString('base64')
    expect(afterCipher).toBe(beforeCipher)
  })

  it("A3 disaster recovery: when the live row is soft-removed first, B's import revives it in place and ownership stays with the original adder (A)", async () => {
    // Global-byEmail dedupe means a tombstoned row for the same email
    // is REVIVED in place — the row's `userId` does NOT transfer to the
    // caller. First-claimer ownership doctrine
    // (`convex/subscriptions/mutations.ts:182-186`).
    const t = vault()
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'shared@example.com',
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
    const aBundle = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })

    // Disaster: A soft-removes the live row, then B steps in to restore.
    await t
      .withIdentity(TEST_IDENTITY)
      .mutation(api.subscriptions.mutations.softRemove, { email: 'shared@example.com' })

    const bIdentity = {
      subject: 'user_test_charlie',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_charlie',
      name: 'Charlie',
      email: 'charlie@flatout.solutions',
    }
    const bUserId = await t.run(async (ctx) => {
      return await ctx.db.insert('users', {
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

    // Exactly one live row vault-wide. Owner is A (first claimer), NOT B.
    const allSubs = await t.withIdentity(bIdentity).query(api.subscriptions.queries.list, {})
    expect(allSubs.filter((s) => s.email === 'shared@example.com')).toHaveLength(1)
    const revived = allSubs.find((s) => s.email === 'shared@example.com')
    if (!revived) throw new Error('expected revived row')
    expect(revived.userId).toBe(seeded.userId)
    expect(revived.userId).not.toBe(bUserId)

    // pullForSwitch must work on the revived sub (B can now use it).
    const pulled = await t.withIdentity(bIdentity).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'shared@example.com',
    })
    expect(pulled.plaintextBlob.length).toBeGreaterThan(0)

    // Sanity: A's view matches B's view (shared vault).
    const fromA = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.list, {})
    expect(fromA.map((s) => s._id).sort()).toEqual(allSubs.map((s) => s._id).sort())
  })
})
