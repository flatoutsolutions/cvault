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

  it('upserts the user when primary email is on the explicit per-email allowlist (not the domain list)', async () => {
    const t = vault()
    // Seed: gmail.com is NOT on the domain allowlist; samuel.asseg@gmail.com IS on the email allowlist.
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
    })
    const event = userCreatedEvent({ userId: 'user_samuel', primaryEmail: 'samuel.asseg@gmail.com' })

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
    // Critically, BAPI delete must NOT have been called — the explicit
    // allowlist row covers the user even though gmail.com is not a
    // permitted domain.
    expect(fetchStub).not.toHaveBeenCalled()
    const userRow = await t.run(
      async (ctx) =>
        await ctx.db
          .query('users')
          .withIndex('byExternalId', (q) => q.eq('externalId', 'user_samuel'))
          .unique()
    )
    expect(userRow).not.toBeNull()
    expect(userRow?.primaryEmail).toBe('samuel.asseg@gmail.com')
  })

  it('still deletes when the explicit-email row is for a DIFFERENT email', async () => {
    const t = vault()
    // Seed an explicit-email row for someone else; the incoming user is unrelated.
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmails', { email: 'someone.else@gmail.com', addedAtMs: 1 })
    })
    const event = userCreatedEvent({ userId: 'user_intruder', primaryEmail: 'intruder@gmail.com' })

    const validateRequest = await import('../utils/validateRequest')
    vi.spyOn(validateRequest, 'validateRequest').mockResolvedValue(event as never)

    const deleteFetch = vi.fn(() => Promise.resolve(new Response('', { status: 200 })))
    __setClerkFetch(deleteFetch as unknown as typeof fetch)

    const res = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })

    expect(res.status).toBe(200)
    expect(deleteFetch).toHaveBeenCalledTimes(1)
  })
})

/**
 * `user.deleted` event handling — audit fix #3 + null-id safety fix #2.
 *
 * The Clerk `user.deleted` payload carries the deleted user's id at
 * `event.data.id`. The pre-fix code used `event.data.id!` which crashes
 * on a malformed payload (Svix would then retry with backoff because the
 * webhook handler errored out). Per project rules we never use `!`; the
 * handler must check for `null`/`undefined` explicitly and respond 200
 * (Svix retries on 4xx → bad payloads should drop, not loop).
 *
 * Fix #3 (audit row): every `user.deleted` event must leave a
 * `machineActivity` row attributing the removal to the soon-to-be-removed
 * user, captured BEFORE the row is deleted.
 */
describe('clerkUsersWebhook (user.deleted audit + null-id safety)', () => {
  it('on user.deleted: removes the users row AND inserts a machineActivity audit row', async () => {
    const t = vault()
    // Seed a user that the deletion event will target.
    const seededId = await t.run(async (ctx) =>
      ctx.db.insert('users', {
        externalId: 'user_to_delete',
        name: 'Doomed Dan',
        primaryEmail: 'dan@flatout.solutions',
        otherEmails: [],
      })
    )

    const validateRequest = await import('../utils/validateRequest')
    vi.spyOn(validateRequest, 'validateRequest').mockResolvedValue({
      type: 'user.deleted',
      data: { id: 'user_to_delete' },
    } as never)

    const res = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: '{}',
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })

    expect(res.status).toBe(200)

    // The users row was hard-deleted.
    const after = await t.run(async (ctx) => await ctx.db.get('users', seededId))
    expect(after).toBeNull()

    // An audit row was written attributing the removal to the deleted
    // user. The webhook captures `userId`, writes the audit row WHILE
    // the user row still exists, then deletes — so the FK target is
    // valid at audit-write time. After the delete the FK is dangling
    // (Convex doesn't enforce FK constraints), which matches typical
    // audit-log semantics ("the record of 'this user was removed'
    // survives the user").
    const audit = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    expect(audit).toHaveLength(1)
    expect(audit[0]?.action).toBe('remove')
    expect(audit[0]?.userId).toEqual(seededId)
    // Sentinel `machineId` for webhook-origin events: there is no
    // CLI session associated with a domain-gate / user.deleted event.
    expect(audit[0]?.machineId).toBe('webhook')
  })

  it('on user.deleted with no users row: returns 200 gracefully and writes no audit row', async () => {
    // The webhook may fire for a Clerk user that was rejected at
    // creation time (domain-gate already deleted the orphan row). In
    // that case there is no user to attribute the audit to, so we skip
    // the audit row but still return 200.
    const t = vault()
    const validateRequest = await import('../utils/validateRequest')
    vi.spyOn(validateRequest, 'validateRequest').mockResolvedValue({
      type: 'user.deleted',
      data: { id: 'user_never_existed' },
    } as never)

    const res = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: '{}',
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })

    expect(res.status).toBe(200)
    const audit = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    expect(audit).toHaveLength(0)
  })

  it('on user.deleted with missing data.id: returns 200, makes no DB mutation, does not throw', async () => {
    // Pre-fix: `event.data.id!` would type-coerce `undefined` to a string
    // and call `userByExternalId(ctx, "undefined")` (then `console.warn`).
    // The audit fix replaces the non-null assertion with an explicit
    // null check + console.error + return 200. We verify no users row
    // was written/removed and no audit row landed.
    const t = vault()
    // Seed a row that should remain untouched.
    const survivor = await t.run(async (ctx) =>
      ctx.db.insert('users', {
        externalId: 'user_survives',
        name: 'Surviving Sue',
        primaryEmail: 'sue@flatout.solutions',
        otherEmails: [],
      })
    )

    const validateRequest = await import('../utils/validateRequest')
    vi.spyOn(validateRequest, 'validateRequest').mockResolvedValue({
      type: 'user.deleted',
      data: {},
    } as never)

    // Suppress the expected console.error so test output stays clean
    // while still proving the handler logged the malformed-payload case.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: '{}',
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })

    expect(res.status).toBe(200)
    expect(errSpy).toHaveBeenCalled()

    // Survivor untouched.
    const stillThere = await t.run(async (ctx) => await ctx.db.get('users', survivor))
    expect(stillThere).not.toBeNull()
    // No audit row.
    const audit = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    expect(audit).toHaveLength(0)
  })
})
