/**
 * Phase 1.5 — verify the three authenticated wrappers reject unauth callers
 * and pass the verified identity through to handler.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §11 (`auth.test.ts`).
 */
import { describe, expect, it } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'

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
      await expect(t.mutation(api.subscriptions.mutations.softRemove, { email: 'x@example.com' })).rejects.toThrow(
        /authenticated/i
      )
    })
  })

  describe('authenticatedAction', () => {
    it('throws when called without a Clerk identity', async () => {
      const t = vault()
      // pullForSwitch is the only public action that uses authenticatedAction.
      await expect(t.action(api.subscriptions.actions.pullForSwitch, { slotOrEmail: 'x@example.com' })).rejects.toThrow(
        /authenticated/i
      )
    })
  })
})

describe('authenticated wrappers — runtime allowlist', () => {
  const evilIdentity = {
    subject: 'user_test_evil',
    issuer: 'https://clear-redbird-6.clerk.accounts.dev',
    tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_evil',
    name: 'Evil',
    email: 'evil@gmail.com',
  } as const

  const noEmailIdentity = {
    subject: 'user_test_no_email',
    issuer: 'https://clear-redbird-6.clerk.accounts.dev',
    tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_no_email',
    name: 'NoEmail',
  } as const

  it('rejects wrong-domain identity on query (bootstrap fallback)', async () => {
    const t = vault()
    await expect(t.withIdentity(evilIdentity).query(api.subscriptions.queries.listForUser, {})).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )
  })

  it('rejects wrong-domain on mutation', async () => {
    const t = vault()
    await expect(
      t.withIdentity(evilIdentity).mutation(api.subscriptions.mutations.softRemove, { email: 'x@example.com' })
    ).rejects.toThrow(/EMAIL_DOMAIN_NOT_ALLOWED|domain/i)
  })

  it('rejects wrong-domain on action', async () => {
    const t = vault()
    await expect(
      t.withIdentity(evilIdentity).action(api.subscriptions.actions.pullForSwitch, { slotOrEmail: 'x@example.com' })
    ).rejects.toThrow(/EMAIL_DOMAIN_NOT_ALLOWED|domain/i)
  })

  it('rejects no-email identity', async () => {
    const t = vault()
    await expect(t.withIdentity(noEmailIdentity).query(api.subscriptions.queries.listForUser, {})).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )
  })

  it('accepts identity matching a domain that was added to the table', async () => {
    const t = vault()
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmailDomains', { domain: 'acme.com', addedAtMs: 1 })
      await ctx.db.insert('users', {
        externalId: 'user_test_acme',
        name: 'Acme',
        primaryEmail: 'bob@acme.com',
        otherEmails: [],
      })
    })
    const acmeIdentity = {
      subject: 'user_test_acme',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_acme',
      name: 'Acme',
      email: 'bob@acme.com',
    } as const
    const result = await t.withIdentity(acmeIdentity).query(api.subscriptions.queries.listForUser, {})
    expect(Array.isArray(result)).toBe(true)
  })
})

describe('authenticated wrappers — per-email allowlist', () => {
  const samuelIdentity = {
    subject: 'user_test_samuel',
    issuer: 'https://clear-redbird-6.clerk.accounts.dev',
    tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_samuel',
    name: 'Samuel',
    email: 'samuel.asseg@gmail.com',
  } as const

  it('accepts identity matched ONLY by allowedEmails (domain not on the list)', async () => {
    const t = vault()
    await t.run(async (ctx) => {
      // Bootstrap-fallback covers flatout.solutions; gmail.com is NOT
      // covered. Without the per-email allowlist, samuel would be
      // rejected. With the explicit-email row, the gate must pass.
      await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
      await ctx.db.insert('users', {
        externalId: samuelIdentity.subject,
        name: samuelIdentity.name,
        primaryEmail: samuelIdentity.email,
        otherEmails: [],
      })
    })
    const result = await t.withIdentity(samuelIdentity).query(api.subscriptions.queries.listForUser, {})
    expect(Array.isArray(result)).toBe(true)
  })

  it('accepts on mutation when only the per-email match applies', async () => {
    const t = vault()
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
      await ctx.db.insert('users', {
        externalId: samuelIdentity.subject,
        name: samuelIdentity.name,
        primaryEmail: samuelIdentity.email,
        otherEmails: [],
      })
    })
    // softRemove on a non-existent email throws NOT_FOUND inside the
    // handler, AFTER the gate has run. We're proving the gate did NOT
    // throw EMAIL_DOMAIN_NOT_ALLOWED — capture the rejection and assert
    // on the error string explicitly.
    let caught: unknown = null
    try {
      await t
        .withIdentity(samuelIdentity)
        .mutation(api.subscriptions.mutations.softRemove, { email: 'nothing@here.com' })
    } catch (err) {
      caught = err
    }
    expect(caught).not.toBeNull()
    const message = caught instanceof Error ? caught.message : String(caught)
    const data = caught !== null && typeof caught === 'object' && 'data' in caught ? String(caught.data) : ''
    expect(message + data).not.toMatch(/EMAIL_DOMAIN_NOT_ALLOWED/i)
  })

  it('accepts on action when only the per-email match applies', async () => {
    const t = vault()
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
      await ctx.db.insert('users', {
        externalId: samuelIdentity.subject,
        name: samuelIdentity.name,
        primaryEmail: samuelIdentity.email,
        otherEmails: [],
      })
    })
    // pullForSwitch fails for a DOMAIN-unrelated reason (no subscription
    // matches the slotOrEmail). What we're proving is the gate did NOT
    // throw EMAIL_DOMAIN_NOT_ALLOWED first. Capture the rejection and
    // assert on the error string explicitly so we can't false-pass on a
    // bad regex.
    let caught: unknown = null
    try {
      await t
        .withIdentity(samuelIdentity)
        .action(api.subscriptions.actions.pullForSwitch, { slotOrEmail: 'nothing@here.com' })
    } catch (err) {
      caught = err
    }
    expect(caught).not.toBeNull()
    const message = caught instanceof Error ? caught.message : String(caught)
    const data = caught !== null && typeof caught === 'object' && 'data' in caught ? String(caught.data) : ''
    expect(message + data).not.toMatch(/EMAIL_DOMAIN_NOT_ALLOWED/i)
  })

  it('still rejects when neither domain nor explicit-email match', async () => {
    const t = vault()
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmails', { email: 'someone.else@gmail.com', addedAtMs: 1 })
    })
    await expect(t.withIdentity(samuelIdentity).query(api.subscriptions.queries.listForUser, {})).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )
  })
})
