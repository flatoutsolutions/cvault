/**
 * Phase 1.5 — verify the three authenticated wrappers reject unauth callers
 * and pass the verified identity through to handler.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §11 (`auth.test.ts`).
 */
import { describe, expect, it } from 'vitest'

import { api } from '../_generated/api'
import { TEST_IDENTITY, vault } from '../__tests__/helpers'

describe('authenticated wrappers', () => {
  describe('authenticatedQuery', () => {
    it('throws when called without a Clerk identity', async () => {
      const t = vault()
      await expect(t.query(api.subscriptions.queries.listForUser, {})).rejects.toThrow(/authenticated/i)
    })

    it('passes identity through when caller is authenticated', async () => {
      const t = vault()
      // Seed the Convex `users` row so listForUser returns rather than throws "user not found".
      await t.run(async (ctx) => {
        await ctx.db.insert('users', {
          externalId: TEST_IDENTITY.subject,
          name: TEST_IDENTITY.name,
          primaryEmail: TEST_IDENTITY.email,
          otherEmails: [],
        })
      })

      const result = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
      expect(Array.isArray(result)).toBe(true)
    })
  })

  describe('authenticatedMutation', () => {
    it('throws when called without a Clerk identity', async () => {
      const t = vault()
      await expect(
        t.mutation(api.subscriptions.mutations.softRemove, { email: 'x@example.com' })
      ).rejects.toThrow(/authenticated/i)
    })
  })

  describe('authenticatedAction', () => {
    it('throws when called without a Clerk identity', async () => {
      const t = vault()
      // pullForSwitch is the only public action that uses authenticatedAction.
      await expect(
        t.action(api.subscriptions.actions.pullForSwitch, { slotOrEmail: 'x@example.com' })
      ).rejects.toThrow(/authenticated/i)
    })
  })
})
