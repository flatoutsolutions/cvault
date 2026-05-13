/**
 * Scenario — runtime allowlist end-to-end.
 *
 * Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §7.2
 * Plan: docs/superpowers/plans/2026-05-04-flatout-domain-only.md (Task 10)
 *
 * Exercises the full flow through the in-memory Convex test harness:
 *  1. Bootstrap fallback — empty allowedEmailDomains table → flatout.solutions
 *     allowed; webhook upserts; query succeeds; mint succeeds.
 *  2. Disallowed → webhook deletes via stubbed Clerk BAPI; query rejects;
 *     mint rejects.
 *  3. Dynamic round-trip — alice adds acme.com → bob signs in; alice removes
 *     acme.com → bob blocked.
 *  4. Self-removal blocked — alice cannot remove flatout.solutions while
 *     it's the row containing her own email.
 *
 * Hermetic — no real network, no real Clerk. Mocks @clerk/backend.verifyToken
 * via the same hoisted-factory pattern as convex/cli/mintAction.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
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

describe('scenario — runtime allowlist', () => {
  it('full happy path with bootstrap fallback', async () => {
    const t = vault()
    const event = userEvent({ type: 'user.created', userId: 'user_alice', email: 'alice@flatout.solutions' })
    await mockValidate(event)
    const fetchStub = vi.fn(() => Promise.resolve(new Response('', { status: 200 })))
    __setClerkFetch(fetchStub as unknown as typeof fetch)
    const wh = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })
    expect(wh.status).toBe(200)
    expect(fetchStub).not.toHaveBeenCalled()

    const subs = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(Array.isArray(subs)).toBe(true)

    mockVerify({ sid: 'sess', sub: 'user_alice', email: 'alice@flatout.solutions' })
    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'jwt-ok' }), { status: 200 }))
      ) as unknown as typeof fetch
    )
    const m = await t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'tok' })
    expect(m.jwt).toBe('jwt-ok')
  })

  it('disallowed flow: webhook BAPI-deletes, query rejects, mint rejects', async () => {
    const t = vault()
    const event = userEvent({ type: 'user.created', userId: 'user_bob', email: 'bob@gmail.com' })
    await mockValidate(event)
    const deleteFetch = vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe('https://api.clerk.com/v1/users/user_bob')
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

    const bobIdentity = {
      subject: 'user_bob',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_bob',
      name: 'Bob',
      email: 'bob@gmail.com',
    } as const
    await expect(t.withIdentity(bobIdentity).query(api.subscriptions.queries.listForUser, {})).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )

    mockVerify({ sid: 'sess', sub: 'user_bob', email: 'bob@gmail.com' })
    await expect(t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'tok' })).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )
  })

  it('dynamic round-trip: add acme.com → bob signs in; remove → bob blocked', async () => {
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

    const acmeId = await t
      .withIdentity(TEST_IDENTITY)
      .mutation(api.allowedDomains.mutations.add, { domain: 'acme.com' })

    const bobIdentity = {
      subject: 'user_bob',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_bob',
      name: 'Bob',
      email: 'bob@acme.com',
    } as const
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: bobIdentity.subject,
        name: bobIdentity.name,
        primaryEmail: bobIdentity.email,
        otherEmails: [],
      })
    })
    const bobsubs = await t.withIdentity(bobIdentity).query(api.subscriptions.queries.listForUser, {})
    expect(Array.isArray(bobsubs)).toBe(true)

    await t.withIdentity(TEST_IDENTITY).mutation(api.allowedDomains.mutations.remove, { id: acmeId })

    await expect(t.withIdentity(bobIdentity).query(api.subscriptions.queries.listForUser, {})).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )
  })

  it('self-removal blocked when row matches caller domain', async () => {
    const t = vault()
    let flatoutId: Id<'allowedEmailDomains'> | undefined
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: TEST_IDENTITY.subject,
        name: TEST_IDENTITY.name,
        primaryEmail: TEST_IDENTITY.email,
        otherEmails: [],
      })
      flatoutId = await ctx.db.insert('allowedEmailDomains', {
        domain: 'flatout.solutions',
        addedAtMs: 1,
      })
    })
    expect(flatoutId).toBeDefined()
    await expect(
      t.withIdentity(TEST_IDENTITY).mutation(api.allowedDomains.mutations.remove, { id: flatoutId! })
    ).rejects.toThrow(/CANNOT_REMOVE_OWN_DOMAIN/i)
  })
})
