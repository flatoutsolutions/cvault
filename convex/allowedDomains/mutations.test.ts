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
    await ctx.db.insert('allowedEmailDomains', { domain: 'flatout.solutions', addedAtMs: 1 })
  })
}

describe('allowedDomains.mutations', () => {
  describe('add', () => {
    it('throws when caller is not authenticated', async () => {
      const t = vault()
      await expect(t.mutation(api.allowedDomains.mutations.add, { domain: 'acme.com' })).rejects.toThrow(
        /authenticated|EMAIL_DOMAIN_NOT_ALLOWED/i
      )
    })

    it('normalizes and inserts', async () => {
      const t = vault()
      await seedAlice(t)
      const id = await t
        .withIdentity(TEST_IDENTITY)
        .mutation(api.allowedDomains.mutations.add, { domain: '  ACME.COM ' })
      expect(id).toBeDefined()
      const row = await t.run(async (ctx) => await ctx.db.get('allowedEmailDomains', id))
      expect(row?.domain).toBe('acme.com')
      expect(row?.addedByUserId).toBeDefined()
    })

    it('is idempotent — returns existing id when domain already present', async () => {
      const t = vault()
      await seedAlice(t)
      const first = await t
        .withIdentity(TEST_IDENTITY)
        .mutation(api.allowedDomains.mutations.add, { domain: 'acme.com' })
      const second = await t
        .withIdentity(TEST_IDENTITY)
        .mutation(api.allowedDomains.mutations.add, { domain: 'ACME.COM' })
      expect(second).toBe(first)
    })

    it('throws INVALID_DOMAIN for malformed input', async () => {
      const t = vault()
      await seedAlice(t)
      await expect(
        t.withIdentity(TEST_IDENTITY).mutation(api.allowedDomains.mutations.add, { domain: 'not a domain' })
      ).rejects.toThrow(/INVALID_DOMAIN/i)
    })
  })

  describe('remove', () => {
    it('throws when caller is not authenticated', async () => {
      const t = vault()
      const id = await t.run(
        async (ctx) => await ctx.db.insert('allowedEmailDomains', { domain: 'acme.com', addedAtMs: 1 })
      )
      await expect(t.mutation(api.allowedDomains.mutations.remove, { id })).rejects.toThrow(
        /authenticated|EMAIL_DOMAIN_NOT_ALLOWED/i
      )
    })

    it('deletes a row', async () => {
      const t = vault()
      await seedAlice(t)
      const id = await t.run(
        async (ctx) => await ctx.db.insert('allowedEmailDomains', { domain: 'acme.com', addedAtMs: 1 })
      )
      const result = await t.withIdentity(TEST_IDENTITY).mutation(api.allowedDomains.mutations.remove, { id })
      expect(result).toBeNull()
      const row = await t.run(async (ctx) => await ctx.db.get('allowedEmailDomains', id))
      expect(row).toBeNull()
    })

    it('throws CANNOT_REMOVE_OWN_DOMAIN when removing the caller domain', async () => {
      const t = vault()
      await seedAlice(t)
      const flatoutRow = await t.run(
        async (ctx) =>
          await ctx.db
            .query('allowedEmailDomains')
            .withIndex('byDomain', (q) => q.eq('domain', 'flatout.solutions'))
            .unique()
      )
      expect(flatoutRow).not.toBeNull()
      await expect(
        t.withIdentity(TEST_IDENTITY).mutation(api.allowedDomains.mutations.remove, { id: flatoutRow!._id })
      ).rejects.toThrow(/CANNOT_REMOVE_OWN_DOMAIN/i)
    })

    it('blocks self-removal even when caller email contains multiple @ (uses lastIndexOf boundary)', async () => {
      const t = vault()
      // Seed an allowedDomains row for 'flatout.solutions' AND a users row
      // whose externalId we will sign in as.
      await t.run(async (ctx) => {
        await ctx.db.insert('users', {
          externalId: 'user_multi_at',
          name: 'Multi',
          primaryEmail: 'multi@chunk@flatout.solutions',
          otherEmails: [],
        })
        await ctx.db.insert('allowedEmailDomains', { domain: 'flatout.solutions', addedAtMs: 1 })
      })
      const flatoutRow = await t.run(
        async (ctx) =>
          await ctx.db
            .query('allowedEmailDomains')
            .withIndex('byDomain', (q) => q.eq('domain', 'flatout.solutions'))
            .unique()
      )
      expect(flatoutRow).not.toBeNull()
      const multiAtIdentity = {
        subject: 'user_multi_at',
        issuer: 'https://clear-redbird-6.clerk.accounts.dev',
        tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_multi_at',
        name: 'Multi',
        email: 'multi@chunk@flatout.solutions',
      } as const
      await expect(
        t.withIdentity(multiAtIdentity).mutation(api.allowedDomains.mutations.remove, { id: flatoutRow!._id })
      ).rejects.toThrow(/CANNOT_REMOVE_OWN_DOMAIN/i)
    })

    it('returns null (no-op) when id no longer exists — idempotent', async () => {
      const t = vault()
      await seedAlice(t)
      const id = await t.run(
        async (ctx) => await ctx.db.insert('allowedEmailDomains', { domain: 'gone.com', addedAtMs: 1 })
      )
      // Delete the row directly so the mutation hits the not-found branch.
      await t.run(async (ctx) => {
        await ctx.db.delete('allowedEmailDomains', id)
      })
      const result = await t.withIdentity(TEST_IDENTITY).mutation(api.allowedDomains.mutations.remove, { id })
      expect(result).toBeNull()
    })
  })
})
