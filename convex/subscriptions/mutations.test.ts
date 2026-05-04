import { describe, expect, it, vi } from 'vitest'

import { SECOND_IDENTITY, TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'

/**
 * Spec: §5 (mutations) + §9 (refresh race protection) + §11 (testing).
 *
 * Mutations under test:
 *  - upsert            - creates a new sub or updates an existing one in-place
 *  - softRemove        - sets `removedAt` so listForUser hides it
 *  - rename            - patches just the user-friendly label
 *  - tryAcquireRefreshLease   - atomic CAS for refresh race protection
 *  - releaseRefreshLease      - clears lease if and only if holder matches
 *  - commitRefreshedTokens    - internal mutation called by refresh action
 */

const FAKE_CIPHERTEXT = new ArrayBuffer(32)
const FAKE_NONCE = new ArrayBuffer(12)

describe('subscriptions.mutations.upsert', () => {
  it('throws when the caller is not authenticated', async () => {
    const t = vault()
    await expect(
      t.mutation(api.subscriptions.mutations.upsert, {
        email: 'a@example.com',
        ciphertext: FAKE_CIPHERTEXT,
        nonce: FAKE_NONCE,
        keyVersion: 'v1',
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      })
    ).rejects.toThrow(/authenticated/i)
  })

  it('inserts a new sub and assigns slot 1 when the user has no subs yet', async () => {
    const t = vault()
    await seedUser(t)

    const result = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'first@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    expect(result.created).toBe(true)
    expect(result.slot).toBe(1)
  })

  it('assigns the next free slot when adding additional subs', async () => {
    const t = vault()
    await seedUser(t)

    const a = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'a@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    const b = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'b@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    expect(a.slot).toBe(1)
    expect(b.slot).toBe(2)
  })

  it('updates existing sub in place when the email matches (same slot, new ciphertext)', async () => {
    const t = vault()
    await seedUser(t)

    const initial = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'a@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    const newer = new ArrayBuffer(64)
    const result = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'a@example.com',
      ciphertext: newer,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 120_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    expect(result.created).toBe(false)
    expect(result.slot).toBe(initial.slot)

    // Confirm the row was updated with the new ciphertext (32 -> 64 bytes).
    const row = await t.run(async (ctx) => {
      return await ctx.db
        .query('subscriptions')
        .withIndex('byEmail', (q) => q.eq('email', 'a@example.com'))
        .unique()
    })
    expect(row?.userId).toEqual(initial.userId)
    expect(row?.ciphertext.byteLength).toBe(64)
  })

  it('reuses a previously freed slot after a soft-remove', async () => {
    const t = vault()
    await seedUser(t)

    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'a@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    const b = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'b@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    expect(b.slot).toBe(2)

    // Remove b, then add c -> c should take slot 2 again.
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'b@example.com',
    })
    const c = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'c@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    expect(c.slot).toBe(2)
  })

  it('canonicalizes email to lowercase on insert (case-insensitive storage)', async () => {
    const t = vault()
    await seedUser(t)

    const result = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'Stefan@Example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    const row = await t.run(async (ctx) => await ctx.db.get('subscriptions', result.subId))
    expect(row?.email).toBe('stefan@example.com')
  })

  it('dedupes mixed-case email against existing lowercase row (no duplicate insert)', async () => {
    const t = vault()
    await seedUser(t)

    const first = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'stefan@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    expect(first.created).toBe(true)

    const second = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'STEFAN@EXAMPLE.COM',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 120_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    // The second upsert must hit the same row, not create a new one.
    expect(second.created).toBe(false)
    expect(second.subId).toEqual(first.subId)
    expect(second.slot).toBe(first.slot)
  })

  it('reviving a tombstoned email picks the lowest free slot, not the original slot', async () => {
    const t = vault()
    await seedUser(t)

    // Live: slot 1=a, slot 2=b.
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'a@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'b@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    // Soft-remove BOTH so slots 1 + 2 are tombstoned.
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'a@example.com',
    })
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'b@example.com',
    })
    // Re-add `b` — same email, so the tombstoned row is revived. We want
    // it to land at slot 1 (lowest free among live rows = none) rather
    // than the previously-held slot 2.
    const reborn = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'b@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    expect(reborn.slot).toBe(1)
  })

  it('warns when more than one LIVE row exists for the same email (schema invariant canary)', async () => {
    // Bypassing the dedupe in `upsertSub` requires planting two live
    // rows directly via the test DB. The schema invariant says this
    // should never happen; the canary surfaces it loudly so an operator
    // sees the violation rather than the row silently being ignored.
    const t = vault()
    const userId = await seedUser(t)

    // Plant TWO live rows for the same email — what the canary should
    // detect. Use direct ctx.db.insert so we sidestep the dedupe path.
    await t.run(async (ctx) => {
      await ctx.db.insert('subscriptions', {
        userId,
        email: 'duplicate@example.com',
        slot: 1,
        ciphertext: FAKE_CIPHERTEXT,
        nonce: FAKE_NONCE,
        keyVersion: 'v1',
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
      await ctx.db.insert('subscriptions', {
        userId,
        email: 'duplicate@example.com',
        slot: 2,
        ciphertext: FAKE_CIPHERTEXT,
        nonce: FAKE_NONCE,
        keyVersion: 'v1',
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
        lastRefreshedAt: Date.now(),
      })
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Trigger upsert against the same email — the canary fires before
    // the patch, regardless of which existing row gets selected as
    // first.
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'duplicate@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    expect(warnSpy).toHaveBeenCalled()
    const warnArgs = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warnArgs).toMatch(/more than one LIVE row/i)
    expect(warnArgs).toContain('duplicate@example.com')
    warnSpy.mockRestore()
  })
})

describe('subscriptions.mutations.softRemove', () => {
  it('marks a sub as removed without deleting the row', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'gone@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'gone@example.com',
    })

    const after = await t.run(async (ctx) => {
      return await ctx.db
        .query('subscriptions')
        .withIndex('byEmail', (q) => q.eq('email', 'gone@example.com'))
        .unique()
    })
    expect(after).not.toBeNull()
    expect(after?.userId).toEqual(inserted.userId)
    expect(after?.removedAt).toBeTypeOf('number')
  })

  it('throws when removing a non-existent sub', async () => {
    const t = vault()
    await seedUser(t)

    // Error message format aligned with `pullForSwitch` ("No subscription
    // matching: …") so callers grepping logs see one consistent shape
    // across the action + mutation layers. The error CODE remains
    // NOT_FOUND, which is what programmatic callers pattern-match on.
    await expect(
      t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
        email: 'nobody@example.com',
      })
    ).rejects.toThrow(/no subscription matching/i)
  })

  it('matches case-insensitively (insert lowercase, remove uppercase)', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'stefan@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // Remove via uppercase form — must match the lowercase-stored row.
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'STEFAN@EXAMPLE.COM',
    })

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.removedAt).toBeTypeOf('number')
  })

  it('matches case-insensitively (insert mixed-case, remove lowercase)', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'Stefan@Example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // Insert canonicalizes to lowercase; remove via lowercase form must match.
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'stefan@example.com',
    })

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.removedAt).toBeTypeOf('number')
  })

  it("inserts a machineActivity row with action='remove'", async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'audit-remove@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'audit-remove@example.com',
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const removeRow = rows.find((r) => r.action === 'remove')
    expect(removeRow).toBeDefined()
    expect(removeRow?.subscriptionId).toEqual(inserted.subId)
  })

  /**
   * Machine label propagation. The CLI's `cvault remove` forwards
   * `session.machineLabel` so the dashboard's "Machines" view can render
   * a human-readable identifier for the originating machine. When the
   * caller passes the optional arg, the audit row must persist it.
   */
  it('persists machineLabel on the machineActivity row when supplied', async () => {
    const t = vault()
    await seedUser(t)
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'label-remove@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'label-remove@example.com',
      machineLabel: 'office-laptop',
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const removeRow = rows.find((r) => r.action === 'remove')
    expect(removeRow?.machineLabel).toBe('office-laptop')
  })

  it('omits machineLabel from the machineActivity row when not supplied (legacy compat)', async () => {
    const t = vault()
    await seedUser(t)
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'legacy-remove@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'legacy-remove@example.com',
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const removeRow = rows.find((r) => r.action === 'remove')
    expect(removeRow?.machineLabel).toBeUndefined()
  })

  /**
   * Shared-vault: any authenticated allowed-domain caller can soft-remove
   * any row regardless of nominal owner. See `convex/utils/users.ts:3-7`.
   * Pre-fix the lookup keyed on `(callerUserId, email)` so cross-user
   * removal returned NOT_FOUND. Reads + actions were already unscoped in
   * PRs #15-#18; this is the parity fix for the public mutation layer.
   *
   * The audit row's `userId` records the ACTOR (alice), not the row owner
   * (bob) — same decision as PR #18 for actions: attributing the action
   * to the row owner under shared vault would falsely log who did what.
   */
  it('cross-user: alice can soft-remove a sub created by bob (shared vault)', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    await seedUser(t, SECOND_IDENTITY)

    // Bob inserts the sub.
    const inserted = await t.withIdentity(SECOND_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'bob-owns@flatout.solutions',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // Alice (different Clerk identity) soft-removes bob's sub.
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'bob-owns@flatout.solutions',
    })

    // The row's `removedAt` is now set — successful cross-user soft-remove.
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.removedAt).toBeTypeOf('number')

    // The audit row attributes the action to alice (actor), not bob (row owner).
    const audit = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const removeRow = audit.find((r) => r.action === 'remove')
    expect(removeRow).toBeDefined()
    expect(removeRow?.subscriptionId).toEqual(inserted.subId)
    expect(removeRow?.userId).toEqual(aliceId)
    // Sanity: the actor MUST NOT be the sub owner under shared vault.
    expect(removeRow?.userId).not.toEqual(inserted.userId)
  })
})

describe('subscriptions.mutations.rename', () => {
  it('updates only the label and leaves other fields intact', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'rename@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.rename, {
      email: 'rename@example.com',
      label: 'My Personal Sub',
    })

    const after = await t.run(async (ctx) => {
      return await ctx.db
        .query('subscriptions')
        .withIndex('byEmail', (q) => q.eq('email', 'rename@example.com'))
        .unique()
    })
    expect(after?.userId).toEqual(inserted.userId)
    expect(after?.label).toBe('My Personal Sub')
    // Other fields untouched.
    expect(after?.subscriptionType).toBe('max')
    expect(after?.slot).toBe(inserted.slot)
  })

  it("inserts a machineActivity row with action='rename'", async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'audit-rename@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.rename, {
      email: 'audit-rename@example.com',
      label: 'Personal',
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const renameRow = rows.find((r) => r.action === 'rename')
    expect(renameRow).toBeDefined()
    expect(renameRow?.subscriptionId).toEqual(inserted.subId)
  })

  it('matches case-insensitively (insert lowercase, rename via uppercase)', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'rename-case@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // Rename via uppercase form must reach the lowercase-stored row.
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.rename, {
      email: 'RENAME-CASE@EXAMPLE.COM',
      label: 'Renamed',
    })

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.label).toBe('Renamed')
  })

  it('persists machineLabel on the machineActivity row when supplied', async () => {
    const t = vault()
    await seedUser(t)
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'label-rename@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.rename, {
      email: 'label-rename@example.com',
      label: 'Personal Max',
      machineLabel: 'kitchen-mac',
    })

    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const renameRow = rows.find((r) => r.action === 'rename')
    expect(renameRow?.machineLabel).toBe('kitchen-mac')
  })

  /**
   * Shared-vault parity fix — see `softRemove` cross-user test for the
   * full rationale. `rename` had the same `(callerUserId, email)` lookup
   * bug; this test pins the cross-user fix.
   */
  it('cross-user: alice can rename a sub created by bob (shared vault)', async () => {
    const t = vault()
    const aliceId = await seedUser(t, TEST_IDENTITY)
    await seedUser(t, SECOND_IDENTITY)

    const inserted = await t.withIdentity(SECOND_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'bob-rename@flatout.solutions',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.rename, {
      email: 'bob-rename@flatout.solutions',
      label: 'Renamed by Alice',
    })

    // Label was patched on bob's row by alice.
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.label).toBe('Renamed by Alice')

    // Audit attributes to alice (actor), not bob (owner).
    const audit = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    const renameRow = audit.find((r) => r.action === 'rename')
    expect(renameRow).toBeDefined()
    expect(renameRow?.subscriptionId).toEqual(inserted.subId)
    expect(renameRow?.userId).toEqual(aliceId)
    expect(renameRow?.userId).not.toEqual(inserted.userId)
  })
})

describe('subscriptions.mutations.tryAcquireRefreshLease (CAS)', () => {
  it('grants the lease when no current holder', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'lease@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    const result = await t.mutation(internal.subscriptions.mutations.tryAcquireRefreshLease, {
      subId: inserted.subId,
      holderToken: 'machine-A-token',
    })
    expect(result.acquired).toBe(true)
  })

  it('refuses the lease when another holder still has it within TTL', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'lease@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    const first = await t.mutation(internal.subscriptions.mutations.tryAcquireRefreshLease, {
      subId: inserted.subId,
      holderToken: 'machine-A',
    })
    expect(first.acquired).toBe(true)

    const second = await t.mutation(internal.subscriptions.mutations.tryAcquireRefreshLease, {
      subId: inserted.subId,
      holderToken: 'machine-B',
    })
    expect(second.acquired).toBe(false)
  })

  it('grants the lease again after the previous lease has expired', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'lease@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // Manually set a stale lease in the past.
    await t.run(async (ctx) => {
      await ctx.db.patch('subscriptions', inserted.subId, {
        refreshLeaseHolder: 'old-machine',
        refreshLeaseUntil: Date.now() - 1_000,
      })
    })

    const result = await t.mutation(internal.subscriptions.mutations.tryAcquireRefreshLease, {
      subId: inserted.subId,
      holderToken: 'new-machine',
    })
    expect(result.acquired).toBe(true)
  })
})

describe('subscriptions.mutations.releaseRefreshLease', () => {
  it('clears the lease only if the holder token matches', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'lease@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    await t.mutation(internal.subscriptions.mutations.tryAcquireRefreshLease, {
      subId: inserted.subId,
      holderToken: 'real-holder',
    })

    // Wrong holder tries to release - should be a no-op.
    await t.mutation(internal.subscriptions.mutations.releaseRefreshLease, {
      subId: inserted.subId,
      holderToken: 'wrong-holder',
    })

    const stillHeld = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(stillHeld?.refreshLeaseHolder).toBe('real-holder')

    // Correct holder releases - lease cleared.
    await t.mutation(internal.subscriptions.mutations.releaseRefreshLease, {
      subId: inserted.subId,
      holderToken: 'real-holder',
    })
    const released = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(released?.refreshLeaseHolder).toBeUndefined()
    expect(released?.refreshLeaseUntil).toBeUndefined()
  })
})

describe('subscriptions.mutations.commitRefreshedTokens', () => {
  it('writes new ciphertext + nonce + expiry and clears the lease atomically', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'rotate@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.mutation(internal.subscriptions.mutations.tryAcquireRefreshLease, {
      subId: inserted.subId,
      holderToken: 'holder',
    })

    const newCt = new ArrayBuffer(64)
    const newNonce = new ArrayBuffer(12)
    const futureExpiry = Date.now() + 8 * 60 * 60 * 1000
    const refreshedAt = Date.now()
    await t.mutation(internal.subscriptions.mutations.commitRefreshedTokens, {
      subId: inserted.subId,
      holderToken: 'holder',
      ciphertext: newCt,
      nonce: newNonce,
      keyVersion: 'v1',
      expiresAt: futureExpiry,
      lastRefreshedAt: refreshedAt,
    })

    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.ciphertext.byteLength).toBe(64)
    expect(after?.expiresAt).toBe(futureExpiry)
    expect(after?.lastRefreshedAt).toBe(refreshedAt)
    expect(after?.refreshLeaseHolder).toBeUndefined()
    expect(after?.refreshLeaseUntil).toBeUndefined()
  })

  it('refuses to commit when the holder token does not match the current lease', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'rotate@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    await t.mutation(internal.subscriptions.mutations.tryAcquireRefreshLease, {
      subId: inserted.subId,
      holderToken: 'real',
    })

    await expect(
      t.mutation(internal.subscriptions.mutations.commitRefreshedTokens, {
        subId: inserted.subId,
        holderToken: 'imposter',
        ciphertext: new ArrayBuffer(64),
        nonce: new ArrayBuffer(12),
        keyVersion: 'v1',
        expiresAt: Date.now() + 60_000,
        lastRefreshedAt: Date.now(),
      })
    ).rejects.toThrow(/lease/i)
  })

  // M2 regression: when a late-arriving commit would REGRESS expiresAt,
  // the mutation must skip the patch. Without this CAS, two refresh paths
  // racing leave the LATER-completing-lower-expiry the winner — even
  // though it has older token material.
  it('M2: skips patch when commit expiresAt would regress the row (CAS on expiresAt)', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'rotate@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 60_000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // First lease + commit lands a fresh token with a far-out expiry.
    await t.mutation(internal.subscriptions.mutations.tryAcquireRefreshLease, {
      subId: inserted.subId,
      holderToken: 'first',
    })
    const farFuture = Date.now() + 8 * 60 * 60 * 1000
    const fresh1 = new ArrayBuffer(48)
    await t.mutation(internal.subscriptions.mutations.commitRefreshedTokens, {
      subId: inserted.subId,
      holderToken: 'first',
      ciphertext: fresh1,
      nonce: new ArrayBuffer(12),
      keyVersion: 'v1',
      expiresAt: farFuture,
      lastRefreshedAt: Date.now(),
    })

    // Second pass: a late-arriving lease holder tries to commit with an
    // OLDER expiresAt (e.g. Anthropic returned a token with shorter
    // expires_in this time, or the laptop clock skewed back). The CAS
    // must SKIP the patch — but it must NOT throw, because the lease
    // holder did legitimately complete its work; the right behavior is
    // to just leave the row as-is.
    await t.mutation(internal.subscriptions.mutations.tryAcquireRefreshLease, {
      subId: inserted.subId,
      holderToken: 'second',
    })
    const olderExpiry = farFuture - 60 * 60 * 1000
    const fresh2 = new ArrayBuffer(64)
    await t.mutation(internal.subscriptions.mutations.commitRefreshedTokens, {
      subId: inserted.subId,
      holderToken: 'second',
      ciphertext: fresh2,
      nonce: new ArrayBuffer(12),
      keyVersion: 'v1',
      expiresAt: olderExpiry,
      lastRefreshedAt: Date.now(),
    })

    // Row's expiresAt must remain at the FAR future — the regression was rejected.
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.expiresAt).toBe(farFuture)
    // Ciphertext must remain the WINNER's (48 bytes), not the regressor's (64 bytes).
    expect(after?.ciphertext.byteLength).toBe(48)
    // Lease must still be cleared either way (the second caller's lease).
    expect(after?.refreshLeaseHolder).toBeUndefined()
    expect(after?.refreshLeaseUntil).toBeUndefined()
  })
})

describe('subscriptions.mutations.adoptLocalState', () => {
  it('adopts when localExpiresAt is strictly newer than the row', async () => {
    const t = vault()
    await seedUser(t)
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'adopt@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: Date.now() + 30 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    const newExpiresAt = Date.now() + 4 * 60 * 60 * 1000
    const result = await t.mutation(internal.subscriptions.mutations.adoptLocalState, {
      subId: inserted.subId,
      ciphertext: new ArrayBuffer(64),
      nonce: new ArrayBuffer(12),
      keyVersion: 'v1',
      localExpiresAt: newExpiresAt,
    })
    expect(result.adopted).toBe(true)
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.expiresAt).toBe(newExpiresAt)
  })

  it('skips adoption when localExpiresAt is older than or equal to the row', async () => {
    const t = vault()
    await seedUser(t)
    const rowExpires = Date.now() + 4 * 60 * 60 * 1000
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'adopt@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: rowExpires,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    const result = await t.mutation(internal.subscriptions.mutations.adoptLocalState, {
      subId: inserted.subId,
      ciphertext: new ArrayBuffer(64),
      nonce: new ArrayBuffer(12),
      keyVersion: 'v1',
      localExpiresAt: rowExpires - 1,
    })
    expect(result.adopted).toBe(false)
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    // expiresAt must NOT regress.
    expect(after?.expiresAt).toBe(rowExpires)
  })

  // M3 regression: cap the upper bound on localExpiresAt at 24h beyond now.
  // A skewed laptop clock or a manipulated Keychain blob with
  // `expiresAt = Date.now() + 100 years` would otherwise poison the vault
  // for a century — pull-on-use proactive refresh (`expiresAt < now + 5min`)
  // would never fire and the row would be permanently stuck.
  it('M3: rejects adoption when localExpiresAt exceeds the 24h ceiling', async () => {
    const t = vault()
    await seedUser(t)
    const rowExpires = Date.now() + 30 * 60 * 1000
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'skewed@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: rowExpires,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })

    // Try to adopt a wildly-out-of-bound expiresAt (10 years out).
    const insane = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000
    const result = await t.mutation(internal.subscriptions.mutations.adoptLocalState, {
      subId: inserted.subId,
      ciphertext: new ArrayBuffer(64),
      nonce: new ArrayBuffer(12),
      keyVersion: 'v1',
      localExpiresAt: insane,
    })
    // Adoption must be rejected — the vault is NOT poisoned.
    expect(result.adopted).toBe(false)
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.expiresAt).toBe(rowExpires)
    // ciphertext must NOT have been touched.
    expect(after?.ciphertext.byteLength).toBe(FAKE_CIPHERTEXT.byteLength)
  })

  it('M3: accepts adoption at exactly the 24h ceiling boundary', async () => {
    const t = vault()
    await seedUser(t)
    const rowExpires = Date.now() + 30 * 60 * 1000
    const inserted = await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.upsert, {
      email: 'boundary@example.com',
      ciphertext: FAKE_CIPHERTEXT,
      nonce: FAKE_NONCE,
      keyVersion: 'v1',
      expiresAt: rowExpires,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
    })
    // 23h59m out — comfortably inside the 24h cap.
    const justInside = Date.now() + 23 * 60 * 60 * 1000 + 59 * 60 * 1000
    const result = await t.mutation(internal.subscriptions.mutations.adoptLocalState, {
      subId: inserted.subId,
      ciphertext: new ArrayBuffer(64),
      nonce: new ArrayBuffer(12),
      keyVersion: 'v1',
      localExpiresAt: justInside,
    })
    expect(result.adopted).toBe(true)
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', inserted.subId))
    expect(after?.expiresAt).toBe(justInside)
  })
})
