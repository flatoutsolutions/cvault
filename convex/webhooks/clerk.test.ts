/**
 * Webhook handler tests — domain-rejection branch.
 *
 * Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §3.3
 *
 * We test the *flow*: was the right Clerk BAPI call made, was upsert called
 * vs skipped, was the orphan users row removed if present.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { vault } from '../__tests__/helpers'
import { __setClerkFetch } from '../cli/clerk'

const ORIGINAL_CLERK_KEY = process.env.CLERK_SECRET_KEY
const ORIGINAL_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = 'sk_test_dummy_for_unit_tests'
  // Use any value — validateRequest is mocked in these tests, so the
  // secret never actually verifies anything.
  process.env.CLERK_WEBHOOK_SECRET = 'whsec_dummy_for_unit_tests'
})

afterEach(() => {
  if (ORIGINAL_CLERK_KEY === undefined) delete process.env.CLERK_SECRET_KEY
  else process.env.CLERK_SECRET_KEY = ORIGINAL_CLERK_KEY
  if (ORIGINAL_WEBHOOK_SECRET === undefined) delete process.env.CLERK_WEBHOOK_SECRET
  else process.env.CLERK_WEBHOOK_SECRET = ORIGINAL_WEBHOOK_SECRET
  __setClerkFetch(undefined)
  vi.restoreAllMocks()
})

function userCreatedEvent(opts: { userId: string; primaryEmail: string; primaryEmailId?: string }): object {
  const primaryEmailId = opts.primaryEmailId ?? `idn_primary_${opts.userId}`
  return {
    type: 'user.created',
    data: {
      id: opts.userId,
      first_name: 'Alice',
      last_name: 'Tester',
      primary_email_address_id: primaryEmailId,
      email_addresses: [{ id: primaryEmailId, email_address: opts.primaryEmail }],
      image_url: null,
    },
  }
}

describe('clerkUsersWebhook (domain gate)', () => {
  it('upserts the user when primary email is on the allowed domain', async () => {
    const t = vault()
    const event = userCreatedEvent({ userId: 'user_alice', primaryEmail: 'alice@flatout.solutions' })

    // Mock validateRequest to return our event directly.
    const validateRequest = await import('../utils/validateRequest')
    vi.spyOn(validateRequest, 'validateRequest').mockResolvedValue(event as never)

    const fetchStub = vi.fn(() => Promise.resolve(new Response('', { status: 200 })))
    __setClerkFetch(fetchStub as unknown as typeof fetch)

    const res = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })

    expect(res.status).toBe(200)
    // BAPI delete must NOT have been called for an allowed user.
    expect(fetchStub).not.toHaveBeenCalled()
    // users row should exist.
    const userRow = await t.run(
      async (ctx) =>
        await ctx.db
          .query('users')
          .withIndex('byExternalId', (q) => q.eq('externalId', 'user_alice'))
          .unique()
    )
    expect(userRow).not.toBeNull()
    expect(userRow?.primaryEmail).toBe('alice@flatout.solutions')
  })

  it('deletes the Clerk user via BAPI when primary email is wrong-domain', async () => {
    const t = vault()
    const event = userCreatedEvent({ userId: 'user_bob', primaryEmail: 'bob@gmail.com' })

    const validateRequest = await import('../utils/validateRequest')
    vi.spyOn(validateRequest, 'validateRequest').mockResolvedValue(event as never)

    const fetchStub = vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe('https://api.clerk.com/v1/users/user_bob')
      expect(init.method).toBe('DELETE')
      expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer sk_test_/)
      return Promise.resolve(new Response('', { status: 200 }))
    })
    __setClerkFetch(fetchStub as unknown as typeof fetch)

    const res = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })

    expect(res.status).toBe(200)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    // users row should NOT have been inserted.
    const userRow = await t.run(
      async (ctx) =>
        await ctx.db
          .query('users')
          .withIndex('byExternalId', (q) => q.eq('externalId', 'user_bob'))
          .unique()
    )
    expect(userRow).toBeNull()
  })

  it('removes orphan users row if disallowed user already had one', async () => {
    const t = vault()
    // Seed an orphan row for someone whose email later turned wrong-domain.
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: 'user_carol',
        name: 'Carol',
        primaryEmail: 'carol@gmail.com',
        otherEmails: [],
      })
    })

    const event = userCreatedEvent({ userId: 'user_carol', primaryEmail: 'carol@gmail.com' })
    const validateRequest = await import('../utils/validateRequest')
    vi.spyOn(validateRequest, 'validateRequest').mockResolvedValue(event as never)

    __setClerkFetch(vi.fn(() => Promise.resolve(new Response('', { status: 200 }))) as unknown as typeof fetch)

    const res = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })

    expect(res.status).toBe(200)
    const userRow = await t.run(
      async (ctx) =>
        await ctx.db
          .query('users')
          .withIndex('byExternalId', (q) => q.eq('externalId', 'user_carol'))
          .unique()
    )
    expect(userRow).toBeNull()
  })

  it('returns 500 when BAPI delete fails with 5xx (Clerk should retry)', async () => {
    const t = vault()
    const event = userCreatedEvent({ userId: 'user_dan', primaryEmail: 'dan@gmail.com' })

    const validateRequest = await import('../utils/validateRequest')
    vi.spyOn(validateRequest, 'validateRequest').mockResolvedValue(event as never)

    __setClerkFetch(
      vi.fn(() => Promise.resolve(new Response('clerk down', { status: 503 }))) as unknown as typeof fetch
    )

    const res = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })

    expect(res.status).toBe(500)
  })

  it('treats BAPI 404 as success (user already deleted)', async () => {
    const t = vault()
    const event = userCreatedEvent({ userId: 'user_evan', primaryEmail: 'evan@gmail.com' })

    const validateRequest = await import('../utils/validateRequest')
    vi.spyOn(validateRequest, 'validateRequest').mockResolvedValue(event as never)

    __setClerkFetch(vi.fn(() => Promise.resolve(new Response('not found', { status: 404 }))) as unknown as typeof fetch)

    const res = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })

    expect(res.status).toBe(200)
  })
})
