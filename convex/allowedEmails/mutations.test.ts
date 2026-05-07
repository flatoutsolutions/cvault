import { describe, expect, it } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'

async function seedAlice(t: ReturnType<typeof vault>) {
  await t.run(async (ctx) => {
    await ctx.db.insert('users', {
      externalId: TEST_IDENTITY.subject,
      name: TEST_IDENTITY.name,
      primaryEmail: TEST_IDENTITY.email,
      otherEmails: [],
    })
    // Need an allowed domain so alice's authenticatedMutation passes the gate.
    await ctx.db.insert('allowedEmailDomains', { domain: 'flatout.solutions', addedAtMs: 1 })
  })
}

describe('allowedEmails.mutations', () => {
  describe('add', () => {
    it('throws when caller is not authenticated', async () => {
      const t = vault()
      await expect(t.mutation(api.allowedEmails.mutations.add, { email: 'samuel.asseg@gmail.com' })).rejects.toThrow(
        /authenticated|EMAIL_DOMAIN_NOT_ALLOWED/i
      )
    })

    it('normalizes and inserts', async () => {
      const t = vault()
      await seedAlice(t)
      const id = await t
        .withIdentity(TEST_IDENTITY)
        .mutation(api.allowedEmails.mutations.add, { email: '  Samuel.Asseg@Gmail.com ' })
      expect(id).toBeDefined()
      const row = await t.run(async (ctx) => await ctx.db.get('allowedEmails', id))
      expect(row?.email).toBe('samuel.asseg@gmail.com')
      expect(row?.addedByUserId).toBeDefined()
    })

    it('is idempotent — returns existing id when email already present', async () => {
      const t = vault()
      await seedAlice(t)
      const first = await t
        .withIdentity(TEST_IDENTITY)
        .mutation(api.allowedEmails.mutations.add, { email: 'samuel.asseg@gmail.com' })
      const second = await t
        .withIdentity(TEST_IDENTITY)
        .mutation(api.allowedEmails.mutations.add, { email: 'SAMUEL.ASSEG@GMAIL.COM' })
      expect(second).toBe(first)
    })

    it('throws EMAIL_INVALID for malformed input', async () => {
      const t = vault()
      await seedAlice(t)
      await expect(
        t.withIdentity(TEST_IDENTITY).mutation(api.allowedEmails.mutations.add, { email: 'not-an-email' })
      ).rejects.toThrow(/EMAIL_INVALID/i)
    })

    it('throws EMAIL_INVALID for multi-@ input', async () => {
      const t = vault()
      await seedAlice(t)
      await expect(
        t.withIdentity(TEST_IDENTITY).mutation(api.allowedEmails.mutations.add, { email: 'a@b@gmail.com' })
      ).rejects.toThrow(/EMAIL_INVALID/i)
    })
  })

  describe('remove', () => {
    it('throws when caller is not authenticated', async () => {
      const t = vault()
      const id = await t.run(
        async (ctx) => await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
      )
      await expect(t.mutation(api.allowedEmails.mutations.remove, { id })).rejects.toThrow(
        /authenticated|EMAIL_DOMAIN_NOT_ALLOWED/i
      )
    })

    it('deletes a row', async () => {
      const t = vault()
      await seedAlice(t)
      const id = await t.run(
        async (ctx) => await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
      )
      const result = await t.withIdentity(TEST_IDENTITY).mutation(api.allowedEmails.mutations.remove, { id })
      expect(result).toBeNull()
      const row = await t.run(async (ctx) => await ctx.db.get('allowedEmails', id))
      expect(row).toBeNull()
    })

    it('throws CANNOT_REMOVE_OWN_EMAIL when removing the caller email', async () => {
      const t = vault()
      await seedAlice(t)
      // Seed an explicit-email row matching alice's own primaryEmail.
      const aliceRowId = await t.run(
        async (ctx) => await ctx.db.insert('allowedEmails', { email: 'alice@flatout.solutions', addedAtMs: 1 })
      )
      await expect(
        t.withIdentity(TEST_IDENTITY).mutation(api.allowedEmails.mutations.remove, { id: aliceRowId })
      ).rejects.toThrow(/CANNOT_REMOVE_OWN_EMAIL/i)
    })

    it('CANNOT_REMOVE_OWN_EMAIL is case-insensitive', async () => {
      const t = vault()
      await seedAlice(t)
      // Stored with different casing than the caller's identity email.
      const rowId = await t.run(
        async (ctx) => await ctx.db.insert('allowedEmails', { email: 'ALICE@flatout.solutions', addedAtMs: 1 })
      )
      await expect(
        t.withIdentity(TEST_IDENTITY).mutation(api.allowedEmails.mutations.remove, { id: rowId })
      ).rejects.toThrow(/CANNOT_REMOVE_OWN_EMAIL/i)
    })

    it('returns null (no-op) when id no longer exists — idempotent', async () => {
      const t = vault()
      await seedAlice(t)
      const id = await t.run(
        async (ctx) => await ctx.db.insert('allowedEmails', { email: 'gone@example.com', addedAtMs: 1 })
      )
      await t.run(async (ctx) => {
        await ctx.db.delete('allowedEmails', id)
      })
      const result = await t.withIdentity(TEST_IDENTITY).mutation(api.allowedEmails.mutations.remove, { id })
      expect(result).toBeNull()
    })
  })
})
