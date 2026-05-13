/**
 * Scenario — per-email allowlist end-to-end.
 *
 * Companion to flatoutDomainOnly.scenario.test.ts. Exercises the runtime
 * gate when a user is allowed only by an explicit-email row (NOT by any
 * domain row).
 *
 *  1. Explicit-email user passes the webhook even when their domain is
 *     not on the domain allowlist; subsequent authed query succeeds; CLI
 *     mint succeeds.
 *  2. A user with neither domain match nor explicit-email match is
 *     rejected (BAPI delete + query rejection).
 *  3. Removing the explicit-email row immediately blocks the previously
 *     allowed user on the next authed call.
 *  4. Adding the same email twice is idempotent (returns the same row id).
 *
 * Hermetic — no real network, no real Clerk. Mocks @clerk/backend.verifyToken
 * via the same hoisted-factory pattern as convex/cli/mintAction.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { __setClerkFetch } from '../cli/clerk'

const verifyTokenMock = vi.hoisted(() => vi.fn())
vi.mock('@clerk/backend', async () => {
  const actual = await vi.importActual<typeof import('@clerk/backend')>('@clerk/backend')
  return {
    ...actual,
    verifyToken: verifyTokenMock,
  }
})

const ORIGINAL_KEY = process.env.CLERK_SECRET_KEY
const ORIGINAL_HOOK = process.env.CLERK_WEBHOOK_SECRET
const ORIGINAL_ENVIRONMENT = process.env.ENVIRONMENT

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = 'sk_test_dummy'
  process.env.CLERK_WEBHOOK_SECRET = 'whsec_dummy'
  // Scenario exercises the production (canonical) webhook reject path
  // (BAPI DELETE on disallowed email). Non-production deployments skip
  // that destructive call — see clerk.test.ts for the dedicated test.
  process.env.ENVIRONMENT = 'production'
  verifyTokenMock.mockReset()
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.CLERK_SECRET_KEY
  else process.env.CLERK_SECRET_KEY = ORIGINAL_KEY
  if (ORIGINAL_HOOK === undefined) delete process.env.CLERK_WEBHOOK_SECRET
  else process.env.CLERK_WEBHOOK_SECRET = ORIGINAL_HOOK
  if (ORIGINAL_ENVIRONMENT === undefined) delete process.env.ENVIRONMENT
  else process.env.ENVIRONMENT = ORIGINAL_ENVIRONMENT
  __setClerkFetch(undefined)
  vi.restoreAllMocks()
})

function userEvent(opts: { type: 'user.created' | 'user.updated'; userId: string; email: string }) {
  const idn = `idn_${opts.userId}`
  return {
    type: opts.type,
    data: {
      id: opts.userId,
      first_name: 'X',
      last_name: 'Y',
      primary_email_address_id: idn,
      email_addresses: [{ id: idn, email_address: opts.email }],
      image_url: null,
    },
  }
}

async function mockValidate(event: object) {
  const mod = await import('../utils/validateRequest')
  vi.spyOn(mod, 'validateRequest').mockResolvedValue(event as never)
}

function mockVerify(payload: object) {
  verifyTokenMock.mockResolvedValue(payload as never)
}

describe('scenario — per-email allowlist', () => {
  it('explicit-email user passes signup webhook + authed APIs + CLI mint', async () => {
    const t = vault()
    // Seed: gmail.com is NOT on the domain allowlist; samuel's email IS
    // on the explicit-email allowlist. Without the per-email path, the
    // webhook would BAPI-delete and the query would reject.
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmailDomains', { domain: 'flatout.solutions', addedAtMs: 1 })
      await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
    })

    const event = userEvent({ type: 'user.created', userId: 'user_samuel', email: 'samuel.asseg@gmail.com' })
    await mockValidate(event)
    const fetchStub = vi.fn(() => Promise.resolve(new Response('', { status: 200 })))
    __setClerkFetch(fetchStub as unknown as typeof fetch)
    const wh = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })
    expect(wh.status).toBe(200)
    // Critical: BAPI delete must NOT have fired even though gmail.com is
    // off the domain allowlist.
    expect(fetchStub).not.toHaveBeenCalled()

    const samuelIdentity = {
      subject: 'user_samuel',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_samuel',
      name: 'Samuel',
      email: 'samuel.asseg@gmail.com',
    } as const
    const subs = await t.withIdentity(samuelIdentity).query(api.subscriptions.queries.listForUser, {})
    expect(Array.isArray(subs)).toBe(true)

    mockVerify({ sid: 'sess_samuel', sub: 'user_samuel', email: 'samuel.asseg@gmail.com' })
    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'jwt-ok' }), { status: 200 }))
      ) as unknown as typeof fetch
    )
    const m = await t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'tok' })
    expect(m.jwt).toBe('jwt-ok')
  })

  it('non-explicit, non-domain user is BAPI-deleted at signup and query-rejected', async () => {
    const t = vault()
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmailDomains', { domain: 'flatout.solutions', addedAtMs: 1 })
      await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
    })

    const event = userEvent({ type: 'user.created', userId: 'user_carla', email: 'carla@gmail.com' })
    await mockValidate(event)
    const deleteFetch = vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe('https://api.clerk.com/v1/users/user_carla')
      expect(init.method).toBe('DELETE')
      return Promise.resolve(new Response('', { status: 200 }))
    })
    __setClerkFetch(deleteFetch as unknown as typeof fetch)
    const wh = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })
    expect(wh.status).toBe(200)
    expect(deleteFetch).toHaveBeenCalledTimes(1)

    const carlaIdentity = {
      subject: 'user_carla',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_carla',
      name: 'Carla',
      email: 'carla@gmail.com',
    } as const
    await expect(t.withIdentity(carlaIdentity).query(api.subscriptions.queries.listForUser, {})).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )
  })

  it('removing the explicit-email row immediately blocks subsequent authed calls', async () => {
    const t = vault()
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: TEST_IDENTITY.subject,
        name: TEST_IDENTITY.name,
        primaryEmail: TEST_IDENTITY.email,
        otherEmails: [],
      })
      await ctx.db.insert('allowedEmailDomains', { domain: 'flatout.solutions', addedAtMs: 1 })
    })

    // Alice (admin, on the bootstrap-fallback flatout.solutions domain)
    // adds samuel's email via the public mutation.
    const samuelEmailRowId = await t
      .withIdentity(TEST_IDENTITY)
      .mutation(api.allowedEmails.mutations.add, { email: 'samuel.asseg@gmail.com' })

    const samuelIdentity = {
      subject: 'user_samuel',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_samuel',
      name: 'Samuel',
      email: 'samuel.asseg@gmail.com',
    } as const
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: samuelIdentity.subject,
        name: samuelIdentity.name,
        primaryEmail: samuelIdentity.email,
        otherEmails: [],
      })
    })

    const before = await t.withIdentity(samuelIdentity).query(api.subscriptions.queries.listForUser, {})
    expect(Array.isArray(before)).toBe(true)

    // Alice removes the explicit-email row.
    await t.withIdentity(TEST_IDENTITY).mutation(api.allowedEmails.mutations.remove, { id: samuelEmailRowId })

    // Samuel's next call is now blocked by the gate.
    await expect(t.withIdentity(samuelIdentity).query(api.subscriptions.queries.listForUser, {})).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )
  })

  it('adding the same email twice is idempotent — returns the same row id', async () => {
    const t = vault()
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: TEST_IDENTITY.subject,
        name: TEST_IDENTITY.name,
        primaryEmail: TEST_IDENTITY.email,
        otherEmails: [],
      })
      await ctx.db.insert('allowedEmailDomains', { domain: 'flatout.solutions', addedAtMs: 1 })
    })
    const a = await t
      .withIdentity(TEST_IDENTITY)
      .mutation(api.allowedEmails.mutations.add, { email: 'someone@example.com' })
    const b = await t
      .withIdentity(TEST_IDENTITY)
      .mutation(api.allowedEmails.mutations.add, { email: 'SOMEONE@EXAMPLE.com' })
    expect(b).toBe(a)
  })
})
