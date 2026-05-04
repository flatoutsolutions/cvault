/**
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { seedSubscription } from '../__scenarios__/_helpers.scenario'
import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import { __setAnthropicFetch } from '../subscriptions/anthropic'
import { parseBundle } from './bundle'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 89).toString('base64')
  // Anthropic stub for any incidental calls (e.g. fetchUsageForSub
  // scheduled by upsertFromPlaintext if it ran).
  __setAnthropicFetch((() => Promise.resolve(new Response('rate-limited', { status: 429 }))) as typeof fetch)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  __setAnthropicFetch(undefined)
  if (ORIGINAL_KEY === undefined) delete process.env.VAULT_AES_KEY
  else process.env.VAULT_AES_KEY = ORIGINAL_KEY
})

describe('exportEncryptedBackup', () => {
  it('returns a base64 bundle that parses cleanly', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'a@example.com', expiresAt: 1 })
    const result = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    expect(result.filename).toMatch(/^cvault-backup-\d{4}-\d{2}-\d{2}\.cvb$/)
    const json = Buffer.from(result.contentBase64, 'base64').toString('utf8')
    const bundle = parseBundle(json)
    expect(bundle.accounts).toHaveLength(1)
    expect(bundle.accounts[0]?.email).toBe('a@example.com')
  })

  it('rejects passphrase < 12 chars', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'a@example.com', expiresAt: 1 })
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
        passphrase: 'short',
      })
    ).rejects.toThrow(/12/)
  })

  it("inserts a machineActivity row with action='export' (audit)", async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'a@example.com', expiresAt: 1 })
    await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    expect(rows.some((r) => r.action === 'export')).toBe(true)
  })

  /**
   * Shared-vault doctrine (`convex/utils/users.ts:3-7`): the bundle is
   * vault-wide. Pre-fix `listSubsForUserId` scoped the export to the
   * caller's `users._id`, so alice's `cvault export` left bob's row
   * outside the disaster-recovery archive — defeating the point of a
   * shared vault. The corrected contract: export = "back up everything
   * in the vault", because that's the only behavior consistent with the
   * "any authed allowlisted email reads/writes any row" model.
   *
   * Operational implication (flagged to user): any authed allowlisted
   * email can now export the FULL vault's encrypted bundle as a backup
   * file. The bundle is still gated by:
   *   1. The user's chosen passphrase (the per-account ciphertexts and
   *      the bundle MAC are bound to it).
   *   2. The server-side master key (decrypt happens server-side before
   *      bundle re-encryption).
   * But once exported, the bundle holds ALL co-tenants' rows. Sharing the
   * passphrase with the wrong person leaks every co-tenant's tokens.
   */
  it('exports every active sub in the vault, not just the callers (shared vault)', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'mine@example.com', expiresAt: 1 })
    // Seed a sub for a different identity. The export under TEST_IDENTITY
    // MUST include it under shared-vault doctrine.
    const other = {
      subject: 'user_other',
      issuer: 'i',
      tokenIdentifier: 'i|user_other',
      name: 'O',
      email: 'o@flatout.solutions',
    }
    await seedSubscription({ t, identity: other, email: 'theirs@example.com', expiresAt: 1 })

    const result = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    const json = Buffer.from(result.contentBase64, 'base64').toString('utf8')
    const bundle = parseBundle(json)
    expect(bundle.accounts).toHaveLength(2)
    const emails = bundle.accounts.map((a) => a.email).sort()
    expect(emails).toEqual(['mine@example.com', 'theirs@example.com'])
  })
})

describe('importEncryptedBackup', () => {
  it('round-trips a freshly exported bundle', async () => {
    const t = vault()
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'roundtrip@example.com',
      expiresAt: 999,
    })
    const exportRes = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    // Soft-remove the original sub so the import doesn't refuse to
    // overwrite (per A3).
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'roundtrip@example.com',
    })

    const restored = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.importEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
      bundleBase64: exportRes.contentBase64,
    })
    expect(restored.restoredCount).toBe(1)

    // The sub should be back (revived in place — see upsertSub semantics).
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', seeded.subId))
    expect(after?.removedAt).toBeUndefined()
  })

  it('rejects bad passphrase (A5: validate-all-then-commit-all atomicity)', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'badpass@example.com', expiresAt: 999 })
    const exportRes = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    // Soft-remove first so the only failure surface is decrypt.
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'badpass@example.com',
    })
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.backup.actions.importEncryptedBackup, {
        passphrase: 'wrong-passphrase-also-long',
        bundleBase64: exportRes.contentBase64,
      })
    ).rejects.toThrow(/passphrase/i)
  })

  it('rejects malformed bundle', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'm@example.com', expiresAt: 1 })
    const garbage = Buffer.from('{"not":"a backup"}', 'utf8').toString('base64')
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.backup.actions.importEncryptedBackup, {
        passphrase: 'correcthorsebatterystaple',
        bundleBase64: garbage,
      })
    ).rejects.toThrow(/version|kind|kdf|account/)
  })

  it('A3: refuses to overwrite live subs with the same email', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'live@example.com', expiresAt: 999 })
    const exportRes = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    // Don't soft-remove — try to import on top of the live sub.
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.backup.actions.importEncryptedBackup, {
        passphrase: 'correcthorsebatterystaple',
        bundleBase64: exportRes.contentBase64,
      })
    ).rejects.toThrow(/overwrite/i)
  })

  it('A4: clamps bundle expiresAt to now + 24h ceiling (vault poisoning defense)', async () => {
    // Build a forged bundle with an absurd expiresAt. The import must
    // clamp it before persistence. We can't cleanly forge inside the
    // server without a passphrase + matching encryption, so we exercise
    // the easier path: re-import a valid bundle whose expiresAt was
    // legitimately set far in the future at export time. The action
    // should clamp it on read.
    const t = vault()
    const farFuture = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'poison@example.com', expiresAt: farFuture })
    const exportRes = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'poison@example.com',
    })
    await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.importEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
      bundleBase64: exportRes.contentBase64,
    })
    const restored = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    const sub = restored.find((s) => s.email === 'poison@example.com')
    const ceiling = Date.now() + 24 * 60 * 60 * 1000
    expect(sub).toBeDefined()
    expect(sub?.expiresAt).toBeLessThanOrEqual(ceiling)
  })

  it("inserts a machineActivity row with action='import' (A6 audit)", async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'audit-import@example.com', expiresAt: 999 })
    const exportRes = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'audit-import@example.com',
    })
    await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.importEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
      bundleBase64: exportRes.contentBase64,
    })
    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    expect(rows.some((r) => r.action === 'import')).toBe(true)
  })
})
