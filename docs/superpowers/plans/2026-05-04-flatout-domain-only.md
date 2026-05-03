# `@flatout.solutions`-only Account Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict cvault account creation and platform access to `@flatout.solutions` email addresses, enforced server-side at every authentication boundary.

**Architecture:** Five layers — (1) Clerk dashboard config (manual), (2) Convex webhook deletes wrong-domain users via Clerk BAPI, (3) Convex auth wrappers reject wrong-domain identities, (4) CLI JWT mint refuses wrong-domain payloads, (5) Frontend DomainGuard signs out wrong-domain users. Single source of truth in `convex/utils/domainGate.ts`.

**Tech Stack:** Convex (functions, http, webhooks), Clerk (`@clerk/backend`, FAPI, BAPI), TanStack Start + Clerk React (`@clerk/tanstack-react-start`), TypeScript on Bun (CLI), Vitest + convex-test + Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md`

---

## File Structure

### Created

| Path                                                          | Responsibility                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `convex/utils/domainGate.ts`                                  | Pure constants + `isAllowedEmail` helper. Frontend + CLI + Convex all import from here. |
| `convex/utils/domainGate.test.ts`                             | Boundary tests for `isAllowedEmail`.                                                    |
| `convex/webhooks/clerk.test.ts`                               | Webhook handler unit tests for domain-rejection branch.                                 |
| `convex/cli/mintAction.test.ts`                               | Mint-action unit tests for domain-rejection branch.                                     |
| `convex/__scenarios__/flatoutDomainOnly.scenario.test.ts`     | End-to-end scenario covering all five layers.                                           |
| `frontend/src/components/auth/DomainGuard.tsx`                | Client-side guard component. UX only.                                                   |
| `frontend/src/components/auth/__tests__/DomainGuard.test.tsx` | RTL tests for DomainGuard.                                                              |

### Modified

| Path                               | Change                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `convex/webhooks/clerk.ts`         | On `user.created`/`user.updated`, branch on `isAllowedEmail`. Disallow → call `deleteClerkUser` + `users.actions.remove`. |
| `convex/utils/auth.ts`             | Each of the three wrappers calls `isAllowedEmail(identity.email)` after the null check. ConvexError on mismatch.          |
| `convex/utils/auth.test.ts`        | New cases for wrong-domain identity rejection on each wrapper.                                                            |
| `convex/cli/clerk.ts`              | New `deleteClerkUser` BAPI helper.                                                                                        |
| `convex/cli/mintAction.ts`         | After `verifyToken`, check `payload.email`. ConvexError on mismatch.                                                      |
| `convex/cli/httpMint.ts`           | Map `EMAIL_DOMAIN_NOT_ALLOWED` ConvexError → HTTP 403.                                                                    |
| `cli/src/auth/clerkFapi.ts`        | New `ClerkEmailDomainNotAllowedError`; `mintConvexJwt` recognizes 403 + code.                                             |
| `cli/src/commands/login.ts`        | Catch the new error, print friendly message, exit 1.                                                                      |
| `cli/tests/auth/clerkFapi.test.ts` | New tests for 403 → `ClerkEmailDomainNotAllowedError`.                                                                    |
| `cli/tests/commands/login.test.ts` | Test friendly error printout.                                                                                             |
| `frontend/src/routes/__root.tsx`   | Wrap `<Outlet />` in `<DomainGuard>` inside `ConvexProviderWithClerk`.                                                    |
| `docs/MANUAL_TESTING.md`           | New section "Email-domain allowlist" + JWT template claims requirement.                                                   |

### Untouched (verified by passing existing tests)

`convex/subscriptions/`, `convex/refreshLog/`, `convex/machineActivity/`, `convex/rateLimit/`, all CLI commands except `login.ts`, schema files.

---

## Branch + Worktree

Already on `feat/flatout-domain-only` at `~/.config/superpowers/worktrees/cvault/feat-flatout-domain-only`, rebased on origin/main (HEAD `1ba4929`). Use this worktree for all tasks. Do NOT cd into `/Users/saadings/Desktop/cvault` — that's a different branch.

---

## Task 1: Domain-gate module + boundary tests

**Files:**

- Create: `convex/utils/domainGate.ts`
- Create: `convex/utils/domainGate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// convex/utils/domainGate.test.ts
import { describe, expect, it } from 'vitest'

import {
  ALLOWED_EMAIL_DOMAIN,
  DOMAIN_REJECTION_ERROR_CODE,
  DOMAIN_REJECTION_MESSAGE,
  isAllowedEmail,
} from './domainGate'

describe('domainGate', () => {
  describe('ALLOWED_EMAIL_DOMAIN', () => {
    it('is the FlatOut Solutions domain', () => {
      expect(ALLOWED_EMAIL_DOMAIN).toBe('flatout.solutions')
    })
  })

  describe('DOMAIN_REJECTION_ERROR_CODE', () => {
    it('is a stable string identifier', () => {
      expect(DOMAIN_REJECTION_ERROR_CODE).toBe('EMAIL_DOMAIN_NOT_ALLOWED')
    })
  })

  describe('DOMAIN_REJECTION_MESSAGE', () => {
    it('mentions the domain', () => {
      expect(DOMAIN_REJECTION_MESSAGE).toMatch(/flatout\.solutions/)
    })
  })

  describe('isAllowedEmail', () => {
    it('accepts canonical FlatOut Solutions email', () => {
      expect(isAllowedEmail('alice@flatout.solutions')).toBe(true)
    })

    it('accepts uppercase variants (case-insensitive)', () => {
      expect(isAllowedEmail('Alice@FlatOut.Solutions')).toBe(true)
      expect(isAllowedEmail('ALICE@FLATOUT.SOLUTIONS')).toBe(true)
    })

    it('accepts plus-tag addresses on the allowed domain', () => {
      expect(isAllowedEmail('alice+work@flatout.solutions')).toBe(true)
    })

    it('rejects different TLD', () => {
      expect(isAllowedEmail('alice@flatout.com')).toBe(false)
    })

    it('rejects subdomain attack', () => {
      expect(isAllowedEmail('alice@evil.flatout.solutions')).toBe(false)
    })

    it('rejects domain-suffix attack', () => {
      expect(isAllowedEmail('alice@flatout.solutions.attacker.com')).toBe(false)
    })

    it('rejects similar-but-different domains', () => {
      expect(isAllowedEmail('alice@gmail.com')).toBe(false)
      expect(isAllowedEmail('alice@flatout.io')).toBe(false)
    })

    it('rejects empty, null, undefined', () => {
      expect(isAllowedEmail('')).toBe(false)
      expect(isAllowedEmail(null)).toBe(false)
      expect(isAllowedEmail(undefined)).toBe(false)
    })

    it('rejects malformed values lacking @', () => {
      expect(isAllowedEmail('aliceflatout.solutions')).toBe(false)
      expect(isAllowedEmail('alice')).toBe(false)
    })

    it('rejects whitespace-padded values (does not trim)', () => {
      // We do not trim — Clerk should never give us padded emails. Reject defensively.
      expect(isAllowedEmail(' alice@flatout.solutions ')).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
yarn test convex/utils/domainGate.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement minimal module**

```ts
// convex/utils/domainGate.ts
/**
 * Domain-gate: single source of truth for the email-domain allowlist.
 *
 * Imports nothing — keep it framework-free so frontend (TanStack Start) and
 * CLI (Bun) can import it without dragging Convex runtime types.
 *
 * Rule: the user's primary email must end with `@flatout.solutions`,
 * case-insensitively. No subdomains. No suffix-attacks.
 *
 * Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §3.2
 */

export const ALLOWED_EMAIL_DOMAIN = 'flatout.solutions'

export const DOMAIN_REJECTION_ERROR_CODE = 'EMAIL_DOMAIN_NOT_ALLOWED'

export const DOMAIN_REJECTION_MESSAGE = 'Only @flatout.solutions accounts may use cvault.'

const ALLOWED_SUFFIX = `@${ALLOWED_EMAIL_DOMAIN}`.toLowerCase()

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (typeof email !== 'string') return false
  if (email.length === 0) return false
  // Reject any whitespace anywhere in the email — Clerk should never send it,
  // and we don't want to accidentally accept '  alice@flatout.solutions  '.
  if (/\s/.test(email)) return false
  return email.toLowerCase().endsWith(ALLOWED_SUFFIX)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
yarn test convex/utils/domainGate.test.ts
```

Expected: PASS, 13/13 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/utils/domainGate.ts convex/utils/domainGate.test.ts
git commit -m "feat(domain-gate): add isAllowedEmail helper + boundary tests"
```

---

## Task 2: Webhook handler — domain branch + BAPI delete

**Files:**

- Modify: `convex/cli/clerk.ts` (new `deleteClerkUser` export)
- Modify: `convex/webhooks/clerk.ts` (branch on domain)
- Create: `convex/webhooks/clerk.test.ts`

- [ ] **Step 1: Write failing webhook tests**

Place these in a new file. They mock `validateRequest` to bypass Svix signature checks (the webhook flow is what we're testing, not Svix), and stub Clerk BAPI via `__setClerkFetch`.

```ts
// convex/webhooks/clerk.test.ts
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

// Helper: build a Clerk webhook envelope that validateRequest will accept
// after we mock it. We mock `validateRequest` itself to return our event
// directly — Svix verification is out of scope for this test.
function makeWebhookRequest(body: object): Request {
  return new Request('http://localhost/webhooks/clerk', {
    method: 'POST',
    headers: {
      'svix-id': 'test',
      'svix-timestamp': String(Date.now()),
      'svix-signature': 'test',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

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
```

- [ ] **Step 2: Run failing tests**

```
yarn test convex/webhooks/clerk.test.ts
```

Expected: FAIL — `deleteClerkUser` is undefined / handler doesn't branch on domain.

- [ ] **Step 3: Add `deleteClerkUser` BAPI helper**

Edit `convex/cli/clerk.ts`. Append at the end of the file:

```ts
interface DeleteUserSuccess {
  ok: true
}

interface DeleteUserError {
  ok: false
  status: number
  body: string
}

export type DeleteUserResult = DeleteUserSuccess | DeleteUserError

/**
 * Delete a Clerk user by id. Used by the Convex webhook to nuke users whose
 * primary email is not on the allowed domain.
 *
 * BAPI: DELETE https://api.clerk.com/v1/users/{user_id}
 *
 * Treats 404 as success — the user is gone, which is the intended end state.
 */
export async function deleteClerkUser(userId: string): Promise<DeleteUserResult> {
  const secret = loadSecretKey()
  const fn = activeFetch()

  const resp = await fn(`${CLERK_API_BASE}/v1/users/${userId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${secret}`,
    },
  })

  if (resp.status === 404) {
    // Already deleted — that's the goal.
    return { ok: true }
  }
  if (!resp.ok) {
    const body = await resp.text()
    return { ok: false, status: resp.status, body }
  }
  return { ok: true }
}
```

- [ ] **Step 4: Refactor webhook handler with domain check**

Replace `convex/webhooks/clerk.ts` entirely:

```ts
'use node'

import type { UserJSON } from '@clerk/backend'

import { internal } from '../_generated/api'
import { httpAction } from '../_generated/server'
import { deleteClerkUser } from '../cli/clerk'
import { isAllowedEmail } from '../utils/domainGate'
import { validateRequest } from '../utils/validateRequest'

function primaryEmailFromUserJSON(data: UserJSON): string | null {
  const primary = data.email_addresses.find((e) => e.id === data.primary_email_address_id)
  return primary?.email_address ?? null
}

export const clerkUsersWebhook = httpAction(async (ctx, request) => {
  const event = await validateRequest(request)
  if (!event) {
    return new Response('Invalid webhook signature', { status: 400 })
  }

  switch (event.type) {
    case 'user.created':
    // intentional fallthrough
    case 'user.updated': {
      const data = event.data
      const email = primaryEmailFromUserJSON(data)
      if (!isAllowedEmail(email)) {
        // Disallowed domain. Nuke via BAPI + remove any orphan users row.
        const userId = data.id
        const result = await deleteClerkUser(userId)
        if (!result.ok) {
          // 5xx from Clerk — return 500 so Clerk retries the webhook later.
          // (404 was treated as success inside deleteClerkUser.)
          console.error(
            `domainGate: BAPI delete failed for ${userId} (${data.email_addresses
              .map((e) => e.email_address)
              .join(',')}) — status=${String(result.status)}, body=${result.body.slice(0, 200)}`
          )
          return new Response('clerk delete failed', { status: 500 })
        }
        // Belt-and-braces: clear any orphan users row that may exist from a
        // prior allowed state (rare — only happens if the user changed their
        // primary email after signup).
        await ctx.runMutation(internal.users.actions.remove, { clerkUserId: userId })
        console.warn(`domainGate: rejected ${userId} primary email ${email ?? '<missing>'} — deleted via BAPI`)
        return new Response(null, { status: 200 })
      }
      await ctx.runMutation(internal.users.actions.upsert, { data })
      break
    }

    case 'user.deleted': {
      const clerkUserId = event.data.id!
      await ctx.runMutation(internal.users.actions.remove, { clerkUserId })
      break
    }

    default:
      console.log('Ignored Clerk webhook event', event.type)
  }

  return new Response(null, { status: 200 })
})
```

- [ ] **Step 5: Run webhook tests**

```
yarn test convex/webhooks/clerk.test.ts
```

Expected: PASS, 5/5 tests.

- [ ] **Step 6: Run all convex tests to catch regressions**

```
yarn test convex/
```

Expected: PASS (no failures introduced in adjacent test files).

- [ ] **Step 7: Commit**

```bash
git add convex/cli/clerk.ts convex/webhooks/clerk.ts convex/webhooks/clerk.test.ts
git commit -m "feat(webhook): reject non-flatout.solutions users via Clerk BAPI delete"
```

---

## Task 3: Auth wrappers — reject wrong-domain identity

**Files:**

- Modify: `convex/utils/auth.ts`
- Modify: `convex/utils/auth.test.ts`

- [ ] **Step 1: Add failing tests for domain rejection**

Append to `convex/utils/auth.test.ts`:

```ts
describe('authenticated wrappers — domain gate', () => {
  it('throws EMAIL_DOMAIN_NOT_ALLOWED for wrong-domain identity on query', async () => {
    const t = vault()
    const wrongDomainIdentity = {
      subject: 'user_test_evil',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_evil',
      name: 'Evil Tester',
      email: 'evil@gmail.com',
    } as const
    await expect(t.withIdentity(wrongDomainIdentity).query(api.subscriptions.queries.listForUser, {})).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|flatout\.solutions/i
    )
  })

  it('throws EMAIL_DOMAIN_NOT_ALLOWED for wrong-domain identity on mutation', async () => {
    const t = vault()
    const wrongDomainIdentity = {
      subject: 'user_test_evil',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_evil',
      name: 'Evil Tester',
      email: 'evil@gmail.com',
    } as const
    await expect(
      t.withIdentity(wrongDomainIdentity).mutation(api.subscriptions.mutations.softRemove, { email: 'x@example.com' })
    ).rejects.toThrow(/EMAIL_DOMAIN_NOT_ALLOWED|flatout\.solutions/i)
  })

  it('throws EMAIL_DOMAIN_NOT_ALLOWED for wrong-domain identity on action', async () => {
    const t = vault()
    const wrongDomainIdentity = {
      subject: 'user_test_evil',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_evil',
      name: 'Evil Tester',
      email: 'evil@gmail.com',
    } as const
    await expect(
      t
        .withIdentity(wrongDomainIdentity)
        .action(api.subscriptions.actions.pullForSwitch, { slotOrEmail: 'x@example.com' })
    ).rejects.toThrow(/EMAIL_DOMAIN_NOT_ALLOWED|flatout\.solutions/i)
  })

  it('throws EMAIL_DOMAIN_NOT_ALLOWED when identity has no email claim at all', async () => {
    const t = vault()
    const noEmailIdentity = {
      subject: 'user_test_no_email',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_no_email',
      name: 'NoEmail Tester',
      // email omitted entirely
    } as const
    await expect(t.withIdentity(noEmailIdentity).query(api.subscriptions.queries.listForUser, {})).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|flatout\.solutions/i
    )
  })

  it('accepts case-insensitive allowed domain', async () => {
    const t = vault()
    const allowedIdentity = {
      subject: 'user_test_caps',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_caps',
      name: 'CapsTester',
      email: 'CapsTester@FlatOut.Solutions',
    } as const
    // Seed the row so the underlying query has something to return.
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: allowedIdentity.subject,
        name: allowedIdentity.name,
        primaryEmail: allowedIdentity.email,
        otherEmails: [],
      })
    })

    const result = await t.withIdentity(allowedIdentity).query(api.subscriptions.queries.listForUser, {})
    expect(Array.isArray(result)).toBe(true)
  })
})
```

- [ ] **Step 2: Run failing tests**

```
yarn test convex/utils/auth.test.ts
```

Expected: FAIL — wrappers don't enforce domain yet.

- [ ] **Step 3: Extend wrappers with domain check**

Replace `convex/utils/auth.ts` entirely:

````ts
/**
 * Authenticated Convex function wrappers.
 *
 * These wrap `query` / `mutation` / `action` and:
 *  1. Verify `ctx.auth.getUserIdentity()` is non-null (else throw).
 *  2. Verify `identity.email` is on the FlatOut Solutions domain
 *     (else throw a ConvexError with code `EMAIL_DOMAIN_NOT_ALLOWED`).
 *  3. Pass the verified `UserIdentity` as `ctx.identity`.
 *
 * Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §3.4
 *
 * USAGE
 * -----
 * Inside an authenticated handler, read the identity via `getIdentity(ctx)`
 * (NOT `ctx.identity` — the runtime augmentation is invisible to TS through
 * the registered-function cast, but `getIdentity` re-asserts it safely):
 *
 * ```ts
 * export const myQuery = authenticatedQuery({
 *   args: {},
 *   handler: async (ctx) => {
 *     const identity = getIdentity(ctx)
 *     return identity.subject
 *   },
 * })
 * ```
 */
import {
  type ActionBuilder,
  type DefaultFunctionArgs,
  type GenericActionCtx,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type MutationBuilder,
  type QueryBuilder,
  type UserIdentity,
} from 'convex/server'
import { ConvexError, type PropertyValidators } from 'convex/values'

import type { DataModel } from '../_generated/dataModel'
import { action, mutation, query } from '../_generated/server'
import { DOMAIN_REJECTION_ERROR_CODE, DOMAIN_REJECTION_MESSAGE, isAllowedEmail } from './domainGate'

/**
 * Read the verified Clerk identity from a ctx that has been augmented by
 * one of the `authenticated*` wrappers.
 *
 * Throws if called from a ctx that wasn't routed through a wrapper (i.e.
 * `identity` was never attached). This indicates a programming error —
 * use the appropriate wrapper instead of calling `getIdentity` from a
 * plain `query`/`mutation`/`action`.
 */
export function getIdentity(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel> | GenericActionCtx<DataModel>
): UserIdentity {
  const augmented = ctx as { identity?: unknown }
  const id = augmented.identity
  if (!id || typeof id !== 'object') {
    throw new Error('getIdentity called on a non-authenticated ctx. Use authenticatedQuery/Mutation/Action.')
  }
  const candidate = id as Record<string, unknown>
  if (
    typeof candidate.subject !== 'string' ||
    typeof candidate.issuer !== 'string' ||
    typeof candidate.tokenIdentifier !== 'string'
  ) {
    throw new Error('Augmented identity is malformed')
  }
  return id as UserIdentity
}

function assertIdentityEmailAllowed(identity: UserIdentity): void {
  // `identity.email` is typed as `string | undefined` on UserIdentity. Clerk's
  // convex JWT template includes it by default; if it's missing the helper
  // returns false and we reject — that's the safe default.
  const email = typeof identity.email === 'string' ? identity.email : null
  if (!isAllowedEmail(email)) {
    throw new ConvexError({
      code: DOMAIN_REJECTION_ERROR_CODE,
      message: DOMAIN_REJECTION_MESSAGE,
    })
  }
}

async function resolveAuthenticatedIdentity(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel> | GenericActionCtx<DataModel>
): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) {
    throw new Error('Not authenticated')
  }
  assertIdentityEmailAllowed(identity)
  return identity
}

export const authenticatedQuery = (<Args extends DefaultFunctionArgs>(fn: {
  args?: PropertyValidators
  returns?: import('convex/values').Validator<unknown>
  handler: (ctx: GenericQueryCtx<DataModel>, args: Args) => Promise<unknown>
}) => {
  return query({
    args: fn.args ?? {},
    ...(fn.returns !== undefined ? { returns: fn.returns } : {}),
    handler: async (ctx, args) => {
      const identity = await resolveAuthenticatedIdentity(ctx)
      return await fn.handler(Object.assign(ctx, { identity }), args as Args)
    },
  })
}) as QueryBuilder<DataModel, 'public'>

export const authenticatedMutation = (<Args extends DefaultFunctionArgs>(fn: {
  args?: PropertyValidators
  returns?: import('convex/values').Validator<unknown>
  handler: (ctx: GenericMutationCtx<DataModel>, args: Args) => Promise<unknown>
}) => {
  return mutation({
    args: fn.args ?? {},
    ...(fn.returns !== undefined ? { returns: fn.returns } : {}),
    handler: async (ctx, args) => {
      const identity = await resolveAuthenticatedIdentity(ctx)
      return await fn.handler(Object.assign(ctx, { identity }), args as Args)
    },
  })
}) as MutationBuilder<DataModel, 'public'>

export const authenticatedAction = (<Args extends DefaultFunctionArgs>(fn: {
  args?: PropertyValidators
  returns?: import('convex/values').Validator<unknown>
  handler: (ctx: GenericActionCtx<DataModel>, args: Args) => Promise<unknown>
}) => {
  return action({
    args: fn.args ?? {},
    ...(fn.returns !== undefined ? { returns: fn.returns } : {}),
    handler: async (ctx, args) => {
      const identity = await resolveAuthenticatedIdentity(ctx)
      return await fn.handler(Object.assign(ctx, { identity }), args as Args)
    },
  })
}) as ActionBuilder<DataModel, 'public'>
````

- [ ] **Step 4: Update existing TEST_IDENTITY in helpers**

The existing `TEST_IDENTITY` in `convex/__tests__/helpers.ts` uses `alice@example.com`. With the new domain gate, this would break every existing test that uses `withIdentity(TEST_IDENTITY)`.

Edit `convex/__tests__/helpers.ts`:

Change:

```ts
export const TEST_IDENTITY = {
  subject: 'user_test_alice',
  issuer: 'https://clear-redbird-6.clerk.accounts.dev',
  tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_alice',
  name: 'Alice Tester',
  email: 'alice@example.com',
} as const

export const SECOND_IDENTITY = {
  subject: 'user_test_bob',
  issuer: 'https://clear-redbird-6.clerk.accounts.dev',
  tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_bob',
  name: 'Bob Tester',
  email: 'bob@example.com',
} as const
```

To:

```ts
export const TEST_IDENTITY = {
  subject: 'user_test_alice',
  issuer: 'https://clear-redbird-6.clerk.accounts.dev',
  tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_alice',
  name: 'Alice Tester',
  email: 'alice@flatout.solutions',
} as const

export const SECOND_IDENTITY = {
  subject: 'user_test_bob',
  issuer: 'https://clear-redbird-6.clerk.accounts.dev',
  tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_test_bob',
  name: 'Bob Tester',
  email: 'bob@flatout.solutions',
} as const
```

- [ ] **Step 5: Run full convex test suite**

```
yarn test convex/
```

Expected: PASS. The fixed `TEST_IDENTITY` now matches the allowed domain, so every existing authenticated test still works. New auth tests pass.

- [ ] **Step 6: Commit**

```bash
git add convex/utils/auth.ts convex/utils/auth.test.ts convex/__tests__/helpers.ts
git commit -m "feat(auth): reject wrong-domain identity in authenticated wrappers"
```

---

## Task 4: CLI mint route — domain rejection

**Files:**

- Modify: `convex/cli/mintAction.ts`
- Modify: `convex/cli/httpMint.ts`
- Create: `convex/cli/mintAction.test.ts`

- [ ] **Step 1: Write failing mintAction tests**

```ts
// convex/cli/mintAction.test.ts
/**
 * mintAction tests — domain rejection branch.
 *
 * verifyToken is mocked via vi.spyOn to return whatever email we want.
 * BAPI mint is mocked via __setClerkFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'
import { __setClerkFetch } from './clerk'

const ORIGINAL_CLERK_KEY = process.env.CLERK_SECRET_KEY

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = 'sk_test_dummy_for_unit_tests'
})

afterEach(() => {
  if (ORIGINAL_CLERK_KEY === undefined) delete process.env.CLERK_SECRET_KEY
  else process.env.CLERK_SECRET_KEY = ORIGINAL_CLERK_KEY
  __setClerkFetch(undefined)
  vi.restoreAllMocks()
})

async function mockVerifyToken(payload: object) {
  const mod = await import('@clerk/backend')
  vi.spyOn(mod, 'verifyToken').mockResolvedValue(payload as never)
}

describe('cli.mintAction.mintConvexJwt — domain gate', () => {
  it('mints when verified payload email is on allowed domain', async () => {
    const t = vault()
    await mockVerifyToken({
      sid: 'sess_alice',
      sub: 'user_alice',
      email: 'alice@flatout.solutions',
    })

    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ jwt: 'fake-convex-jwt' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      ) as unknown as typeof fetch
    )

    const result = await t.action(internal.cli.mintAction.mintConvexJwt, {
      clerkSessionToken: 'fake-session-jwt',
    })
    expect(result.jwt).toBe('fake-convex-jwt')
  })

  it('rejects with EMAIL_DOMAIN_NOT_ALLOWED when email is wrong domain', async () => {
    const t = vault()
    await mockVerifyToken({
      sid: 'sess_bob',
      sub: 'user_bob',
      email: 'bob@gmail.com',
    })

    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'should-not-mint' }), { status: 200 }))
      ) as unknown as typeof fetch
    )

    await expect(t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'fake' })).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|flatout\.solutions/i
    )
  })

  it('rejects with EMAIL_DOMAIN_NOT_ALLOWED when email claim is missing', async () => {
    const t = vault()
    await mockVerifyToken({ sid: 'sess_x', sub: 'user_x' })

    __setClerkFetch(vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))) as unknown as typeof fetch)

    await expect(t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'fake' })).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|flatout\.solutions/i
    )
  })
})
```

- [ ] **Step 2: Run failing tests**

```
yarn test convex/cli/mintAction.test.ts
```

Expected: FAIL — mintAction does not check email yet.

- [ ] **Step 3: Add domain check to mintAction**

Replace `convex/cli/mintAction.ts`:

```ts
'use node'

/**
 * `cli.mintAction.mintConvexJwt` — internal action invoked by the
 * `/api/cli/mint-token` HTTP route. Verifies a CLI-supplied Clerk session
 * JWT via `@clerk/backend`, rejects wrong-domain emails, then mints a
 * convex-template JWT for the underlying session via Clerk Backend API.
 *
 * Why this exists:
 *   The CLI obtains a Clerk session JWT via FAPI's ticket exchange
 *   (`/v1/client/sign_ins`), but cannot mint subsequent template JWTs via
 *   FAPI because `/v1/client/sessions/<sid>/tokens/<template>` authenticates
 *   the *client* (browser cookie context). From a headless caller without
 *   the `__client` cookie, FAPI rejects every Authorization Bearer with 401
 *   `signed_out`. BAPI does not have that constraint — it only requires the
 *   server-side `CLERK_SECRET_KEY`, which lives on the Convex deployment.
 *
 * Domain gate:
 *   Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §3.5
 *   We check the verified payload's `email` claim against the allowlist. If
 *   it doesn't match, mint is refused — the CLI cannot get a Convex JWT and
 *   therefore cannot make any Convex calls.
 *
 * Security model:
 *   - We `verifyToken` the supplied JWT against Clerk's JWKS first. This
 *     proves the caller actually possesses a current Clerk session token —
 *     they are not asking us to mint for an arbitrary `sid` they guessed.
 *   - The `sid` claim from the verified payload is what we pass to BAPI;
 *     `clerkSessionToken` is never trusted as input beyond its `sid`/`sub`
 *     /`email` claims.
 *   - Without verification, a user holding any Clerk JWT could pass a
 *     stolen `sid` and mint a convex JWT for someone else. The secret key
 *     would be a confused deputy.
 */
import { verifyToken } from '@clerk/backend'
import { ConvexError, v } from 'convex/values'

import { internalAction } from '../_generated/server'
import { DOMAIN_REJECTION_ERROR_CODE, DOMAIN_REJECTION_MESSAGE, isAllowedEmail } from '../utils/domainGate'
import { createSessionTokenFromTemplate } from './clerk'

export const mintConvexJwt = internalAction({
  args: { clerkSessionToken: v.string() },
  returns: v.object({ jwt: v.string() }),
  handler: async (_ctx, { clerkSessionToken }): Promise<{ jwt: string }> => {
    const secretKey = process.env.CLERK_SECRET_KEY
    if (!secretKey) {
      throw new ConvexError({
        code: 'CONFIGURATION_ERROR',
        message: 'CLERK_SECRET_KEY is not set on the Convex deployment',
      })
    }

    let payload: { sid?: unknown; sub?: unknown; email?: unknown }
    try {
      payload = (await verifyToken(clerkSessionToken, { secretKey })) as {
        sid?: unknown
        sub?: unknown
        email?: unknown
      }
    } catch (err) {
      throw new ConvexError({
        code: 'SESSION_TOKEN_INVALID',
        message: `Could not verify Clerk session token: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    if (typeof payload.sid !== 'string' || typeof payload.sub !== 'string') {
      throw new ConvexError({
        code: 'SESSION_TOKEN_INVALID',
        message: 'Clerk session token is missing `sid` or `sub` claims',
      })
    }

    const email = typeof payload.email === 'string' ? payload.email : null
    if (!isAllowedEmail(email)) {
      throw new ConvexError({
        code: DOMAIN_REJECTION_ERROR_CODE,
        message: DOMAIN_REJECTION_MESSAGE,
      })
    }

    const result = await createSessionTokenFromTemplate(payload.sid, 'convex')
    if (!result.ok) {
      throw new ConvexError({
        code: result.status === 404 ? 'JWT_TEMPLATE_NOT_FOUND' : 'CLERK_BACKEND_ERROR',
        message: `BAPI mint failed: ${result.status.toString()}: ${result.body.slice(0, 200)}`,
      })
    }

    return { jwt: result.jwt }
  },
})
```

- [ ] **Step 4: Map domain error to HTTP 403 in httpMint.ts**

Edit `convex/cli/httpMint.ts`. Update the status mapping in `cliMintHandler`:

Change the status assignment block:

```ts
const status =
  code === 'SESSION_TOKEN_INVALID'
    ? 401
    : code === 'JWT_TEMPLATE_NOT_FOUND'
      ? 404
      : code === 'CONFIGURATION_ERROR'
        ? 500
        : 500
```

To:

```ts
const status =
  code === 'SESSION_TOKEN_INVALID'
    ? 401
    : code === 'EMAIL_DOMAIN_NOT_ALLOWED'
      ? 403
      : code === 'JWT_TEMPLATE_NOT_FOUND'
        ? 404
        : code === 'CONFIGURATION_ERROR'
          ? 500
          : 500
```

Also update the docstring near the top — the `Errors:` block should now list 403:

Replace:

```
 *   - 400 — body missing / malformed
 *   - 401 — `SESSION_TOKEN_INVALID` (signature, expiry, revocation)
 *   - 404 — `JWT_TEMPLATE_NOT_FOUND` (no `convex` template in Clerk)
 *   - 500 — `CONFIGURATION_ERROR` / `CLERK_BACKEND_ERROR`
```

With:

```
 *   - 400 — body missing / malformed
 *   - 401 — `SESSION_TOKEN_INVALID` (signature, expiry, revocation)
 *   - 403 — `EMAIL_DOMAIN_NOT_ALLOWED` (caller's primary email is not on the FlatOut Solutions domain)
 *   - 404 — `JWT_TEMPLATE_NOT_FOUND` (no `convex` template in Clerk)
 *   - 500 — `CONFIGURATION_ERROR` / `CLERK_BACKEND_ERROR`
```

- [ ] **Step 5: Run mint tests**

```
yarn test convex/cli/mintAction.test.ts
```

Expected: PASS, 3/3.

- [ ] **Step 6: Run full convex test suite**

```
yarn test convex/
```

Expected: PASS overall.

- [ ] **Step 7: Commit**

```bash
git add convex/cli/mintAction.ts convex/cli/mintAction.test.ts convex/cli/httpMint.ts
git commit -m "feat(cli-mint): refuse JWT mint for non-flatout.solutions emails"
```

---

## Task 5: CLI client — recognize 403 + friendly error

**Files:**

- Modify: `cli/src/auth/clerkFapi.ts`
- Modify: `cli/src/commands/login.ts`
- Modify: `cli/tests/auth/clerkFapi.test.ts`

- [ ] **Step 1: Add failing test for new error class**

Append to `cli/tests/auth/clerkFapi.test.ts`:

```ts
describe('mintConvexJwt — 403 EMAIL_DOMAIN_NOT_ALLOWED', () => {
  it('throws ClerkEmailDomainNotAllowedError on 403 with the matching error code', async () => {
    const session = {
      version: 1,
      clerkSessionId: 'sess_test',
      clerkSessionToken: 'fake-session-jwt',
      convexJwt: '',
      convexJwtExpiry: 0,
      frontendApiUrl: 'https://x.clerk.accounts.dev',
      convexUrl: 'https://x.convex.cloud',
      issuedAt: Math.floor(Date.now() / 1000),
    } as const

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'EMAIL_DOMAIN_NOT_ALLOWED',
            message: 'Only @flatout.solutions accounts may use cvault.',
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        )
      )
    ) as unknown as typeof fetch

    try {
      await expect(mintConvexJwt(session)).rejects.toBeInstanceOf(ClerkEmailDomainNotAllowedError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('preserves ClerkSessionExpiredError for plain 401/404', async () => {
    const session = {
      version: 1,
      clerkSessionId: 'sess_test',
      clerkSessionToken: 'fake-session-jwt',
      convexJwt: '',
      convexJwtExpiry: 0,
      frontendApiUrl: 'https://x.clerk.accounts.dev',
      convexUrl: 'https://x.convex.cloud',
      issuedAt: Math.floor(Date.now() / 1000),
    } as const

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'SESSION_TOKEN_INVALID' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    ) as unknown as typeof fetch

    try {
      await expect(mintConvexJwt(session)).rejects.toBeInstanceOf(ClerkSessionExpiredError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
```

Add the new import at the top of the test file:

```ts
import {
  ClerkEmailDomainNotAllowedError,
  ClerkSessionExpiredError,
  decodeJwtExp,
  exchangeTicketForSession,
  mintConvexJwt,
} from '../../src/auth/clerkFapi'
```

(If only some of these are already imported, merge with the existing import.)

- [ ] **Step 2: Run failing tests**

```
cd cli && bunx --bun vitest run tests/auth/clerkFapi.test.ts
```

Expected: FAIL — `ClerkEmailDomainNotAllowedError` does not exist.

- [ ] **Step 3: Add the error class + 403 branch in mintConvexJwt**

Edit `cli/src/auth/clerkFapi.ts`. After the existing `ClerkSessionExpiredError` class, add:

```ts
export class ClerkEmailDomainNotAllowedError extends Error {
  override readonly name = 'ClerkEmailDomainNotAllowedError'
  /** Server-supplied message, e.g. "Only @flatout.solutions accounts may use cvault." */
  readonly serverMessage: string
  constructor(serverMessage: string) {
    super(serverMessage)
    this.serverMessage = serverMessage
  }
}
```

Inside `mintConvexJwt`, replace the body that handles non-2xx responses. Find the block:

```ts
if (res.status === 401 || res.status === 403 || res.status === 404) {
  const body = await res.text().catch(() => '<no body>')
  throw new ClerkSessionExpiredError(res.status, body)
}
if (!res.ok) {
  throw new Error(`Convex mint endpoint failed: ${String(res.status)} ${await res.text()}`)
}
```

Replace with:

```ts
if (!res.ok) {
  const rawBody = await res.text().catch(() => '<no body>')
  // Try to parse the JSON envelope `{ error: <code>, message: <human> }`.
  let parsed: { error?: unknown; message?: unknown } | null = null
  try {
    parsed = JSON.parse(rawBody) as { error?: unknown; message?: unknown }
  } catch {
    parsed = null
  }
  const code = parsed && typeof parsed.error === 'string' ? parsed.error : null
  const message = parsed && typeof parsed.message === 'string' ? parsed.message : rawBody
  if (res.status === 403 && code === 'EMAIL_DOMAIN_NOT_ALLOWED') {
    throw new ClerkEmailDomainNotAllowedError(message)
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new ClerkSessionExpiredError(res.status, rawBody)
  }
  throw new Error(`Convex mint endpoint failed: ${String(res.status)} ${rawBody}`)
}
```

- [ ] **Step 4: Run tests**

```
cd cli && bunx --bun vitest run tests/auth/clerkFapi.test.ts
```

Expected: PASS, including new 403 cases AND existing 401 case still passing.

- [ ] **Step 5: Update login.ts to surface friendly error**

Edit `cli/src/commands/login.ts`. Find the `try { ... } catch (err) { ... }` block around the `exchangeTicketForSession` / mint flow.

Add to the imports near the top:

```ts
import { ClerkEmailDomainNotAllowedError } from '../auth/clerkFapi'
```

Wherever the catch block currently handles errors from mint/exchange (typically just before `process.exit(1)` or a generic console.error), add a branch:

```ts
if (err instanceof ClerkEmailDomainNotAllowedError) {
  console.error(`Error: ${err.serverMessage}`)
  console.error('Sign out at the cvault dashboard and try again with your @flatout.solutions email.')
  process.exit(1)
}
```

If the existing catch is `console.error(err.message); process.exit(1)`, place the new branch above the generic line.

- [ ] **Step 6: Add login.ts test for friendly message**

Locate `cli/tests/commands/login.test.ts` (or create alongside if missing — check directory first via `ls cli/tests/commands/`).

Add a test that mocks the mint to throw the new error and asserts the console output. The exact mock harness should mirror existing login tests (use `__setExchange` / `__setMint` test seams if they exist, or `vi.spyOn(import('../../src/auth/clerkFapi'), 'exchangeTicketForSession')` pattern).

Append to the file:

```ts
it('prints a friendly error and exits 1 when mint returns EMAIL_DOMAIN_NOT_ALLOWED', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called')
  })

  // Mock exchangeTicketForSession (or whatever entrypoint login uses) to
  // throw ClerkEmailDomainNotAllowedError. Adjust this to match the actual
  // login.ts internals you find.
  const fapi = await import('../../src/auth/clerkFapi')
  vi.spyOn(fapi, 'exchangeTicketForSession').mockRejectedValue(
    new fapi.ClerkEmailDomainNotAllowedError('Only @flatout.solutions accounts may use cvault.')
  )

  // Drive login() with a fake ticket + minimal opts; the test setup may
  // already have a helper for this — reuse it. If not, the simplest path is
  // to invoke whatever function login.ts exports and pass a stub callback
  // server. Match the existing pattern in this file.
  const { runLogin } = await import('../../src/commands/login')
  await expect(
    runLogin({
      /* fill from existing tests in this file */
    } as Parameters<typeof runLogin>[0])
  ).rejects.toThrow(/process\.exit called/)

  expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/flatout\.solutions/i))
  expect(exitSpy).toHaveBeenCalledWith(1)

  errorSpy.mockRestore()
  exitSpy.mockRestore()
})
```

> **Implementer note:** The exact shape of `runLogin`'s args depends on existing login.ts internals. Read `cli/src/commands/login.ts` first and pattern-match this test on whatever harness the existing login.ts tests use. Do NOT reinvent — reuse.

- [ ] **Step 7: Run CLI tests**

```
cd cli && bunx --bun vitest run
```

Expected: PASS overall.

- [ ] **Step 8: Commit**

```bash
git add cli/src/auth/clerkFapi.ts cli/src/commands/login.ts cli/tests/auth/clerkFapi.test.ts cli/tests/commands/login.test.ts
git commit -m "feat(cli): surface @flatout.solutions-only error from mint endpoint"
```

---

## Task 6: Frontend DomainGuard

**Files:**

- Create: `frontend/src/components/auth/DomainGuard.tsx`
- Create: `frontend/src/components/auth/__tests__/DomainGuard.test.tsx`
- Modify: `frontend/src/routes/__root.tsx`

- [ ] **Step 1: Write failing RTL tests**

```tsx
// frontend/src/components/auth/__tests__/DomainGuard.test.tsx
/**
 * DomainGuard — UX layer of the @flatout.solutions allowlist. Backend already
 * enforces the gate; this component shows a friendly error rather than letting
 * the user see broken Convex calls everywhere.
 *
 * Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §3.6
 */
import { useClerk, useUser } from '@clerk/tanstack-react-start'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DomainGuard } from '../DomainGuard'

// Per Clerk's testing docs, mock the hook surface. The shape mirrors what
// `useUser()` and `useClerk()` return — only the fields we read.
vi.mock('@clerk/tanstack-react-start', () => ({
  useUser: vi.fn(),
  useClerk: vi.fn(),
}))

const mockedUseUser = vi.mocked(useUser)
const mockedUseClerk = vi.mocked(useClerk)

describe('DomainGuard', () => {
  it('renders children while Clerk is still loading', () => {
    mockedUseUser.mockReturnValue({ isLoaded: false, isSignedIn: false, user: null } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    // While loading, render null. Test that protected child is NOT visible.
    expect(screen.queryByText('protected')).toBeNull()
  })

  it('renders children when signed out (downstream gate handles it)', () => {
    mockedUseUser.mockReturnValue({ isLoaded: true, isSignedIn: false, user: null } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.getByText('protected')).toBeInTheDocument()
  })

  it('renders children when signed in with allowed-domain email', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'alice@flatout.solutions' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.getByText('protected')).toBeInTheDocument()
  })

  it('renders blocked-error page when signed in with disallowed-domain email', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'bob@gmail.com' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
    expect(screen.getByText(/flatout\.solutions/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument()
  })

  it('blocked page sign-out button calls Clerk signOut', async () => {
    const signOut = vi.fn()
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'bob@gmail.com' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut } as never)
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    const btn = screen.getByRole('button', { name: /sign out/i })
    await userEvent.click(btn)
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('blocked when signed in but user has no primary email', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: null },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
    expect(screen.getByText(/flatout\.solutions/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run failing tests**

```
yarn test frontend/src/components/auth/__tests__/DomainGuard.test.tsx
```

Expected: FAIL — DomainGuard doesn't exist.

- [ ] **Step 3: Implement DomainGuard**

```tsx
// frontend/src/components/auth/DomainGuard.tsx
/**
 * Client-side guard that enforces the @flatout.solutions email-domain rule
 * for UX purposes only. The backend already rejects every non-matching
 * identity at the Convex auth wrapper layer; without this guard, a wrong-
 * domain user would see the dashboard render and then break with errors
 * everywhere. Cleaner: show them an explicit "you can't use this app"
 * page and a sign-out button.
 *
 * Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §3.6
 */
import { useClerk, useUser } from '@clerk/tanstack-react-start'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'

import { ALLOWED_EMAIL_DOMAIN, DOMAIN_REJECTION_MESSAGE, isAllowedEmail } from '../../../../convex/utils/domainGate'

export function DomainGuard({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, user } = useUser()
  const { signOut } = useClerk()

  if (!isLoaded) return null
  if (!isSignedIn) return <>{children}</>

  const email = user?.primaryEmailAddress?.emailAddress ?? null
  if (isAllowedEmail(email)) return <>{children}</>

  return <DomainBlocked onSignOut={() => signOut()} email={email} />
}

function DomainBlocked({ onSignOut, email }: { onSignOut: () => void; email: string | null }) {
  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">cvault is restricted</h1>
        <p className="text-muted-foreground mt-2 max-w-md text-sm">
          {DOMAIN_REJECTION_MESSAGE} Your current account
          {email ? ` (${email})` : ''} is not on the <code>@{ALLOWED_EMAIL_DOMAIN}</code> domain.
        </p>
      </div>
      <Button onClick={onSignOut} size="lg" variant="default">
        Sign out
      </Button>
    </div>
  )
}
```

- [ ] **Step 4: Run RTL tests**

```
yarn test frontend/src/components/auth/__tests__/DomainGuard.test.tsx
```

Expected: PASS, 6/6.

- [ ] **Step 5: Wire DomainGuard into the root route**

Edit `frontend/src/routes/__root.tsx`. Add to the imports:

```ts
import { DomainGuard } from '../components/auth/DomainGuard'
```

In `RootComponent`, wrap `<Outlet />` inside the guard:

Replace:

```tsx
function RootComponent() {
  const { convexClient } = Route.useRouteContext()

  return (
    <ClerkProvider appearance={{ baseTheme: dark }}>
      <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
        <Outlet />
      </ConvexProviderWithClerk>
    </ClerkProvider>
  )
}
```

With:

```tsx
function RootComponent() {
  const { convexClient } = Route.useRouteContext()

  return (
    <ClerkProvider appearance={{ baseTheme: dark }}>
      <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
        <DomainGuard>
          <Outlet />
        </DomainGuard>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  )
}
```

- [ ] **Step 6: Run frontend tests**

```
yarn test frontend/
```

Expected: PASS overall — DomainGuard tests + existing component/route tests still green.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/auth/DomainGuard.tsx frontend/src/components/auth/__tests__/DomainGuard.test.tsx frontend/src/routes/__root.tsx
git commit -m "feat(frontend): DomainGuard for @flatout.solutions-only access"
```

---

## Task 7: End-to-end scenario test

**Files:**

- Create: `convex/__scenarios__/flatoutDomainOnly.scenario.test.ts`

- [ ] **Step 1: Write the scenario**

```ts
// convex/__scenarios__/flatoutDomainOnly.scenario.test.ts
/**
 * Scenario — `@flatout.solutions`-only allowlist end-to-end.
 *
 * What this asserts:
 *  - Webhook for an allowed user inserts the users row.
 *  - Webhook for a disallowed user calls Clerk BAPI DELETE /v1/users/{id}
 *    and does NOT insert a users row.
 *  - Authenticated query rejects wrong-domain identities.
 *  - cli.mintAction.mintConvexJwt rejects wrong-domain payloads.
 *  - Case-insensitive: Alice@FlatOut.Solutions is allowed.
 *  - Missing email claim defaults to deny.
 *
 * Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §7.2
 *
 * Hermetic: convex-test in-memory + __setClerkFetch stub + verifyToken vi.spyOn.
 * No real network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { __setClerkFetch } from '../cli/clerk'

const ORIGINAL_CLERK_KEY = process.env.CLERK_SECRET_KEY
const ORIGINAL_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = 'sk_test_dummy_for_scenario'
  process.env.CLERK_WEBHOOK_SECRET = 'whsec_dummy_for_scenario'
})

afterEach(() => {
  if (ORIGINAL_CLERK_KEY === undefined) delete process.env.CLERK_SECRET_KEY
  else process.env.CLERK_SECRET_KEY = ORIGINAL_CLERK_KEY
  if (ORIGINAL_WEBHOOK_SECRET === undefined) delete process.env.CLERK_WEBHOOK_SECRET
  else process.env.CLERK_WEBHOOK_SECRET = ORIGINAL_WEBHOOK_SECRET
  __setClerkFetch(undefined)
  vi.restoreAllMocks()
})

function userEvent(opts: { type: 'user.created' | 'user.updated'; userId: string; email: string }) {
  const primaryEmailId = `idn_primary_${opts.userId}`
  return {
    type: opts.type,
    data: {
      id: opts.userId,
      first_name: 'Test',
      last_name: 'User',
      primary_email_address_id: primaryEmailId,
      email_addresses: [{ id: primaryEmailId, email_address: opts.email }],
      image_url: null,
    },
  }
}

async function mockValidateRequestReturning(event: object) {
  const mod = await import('../utils/validateRequest')
  vi.spyOn(mod, 'validateRequest').mockResolvedValue(event as never)
}

async function mockVerifyTokenReturning(payload: object) {
  const mod = await import('@clerk/backend')
  vi.spyOn(mod, 'verifyToken').mockResolvedValue(payload as never)
}

describe('scenario — @flatout.solutions allowlist', () => {
  it('full happy path: allowed webhook → users row → authenticated query succeeds → mint succeeds', async () => {
    const t = vault()
    const event = userEvent({ type: 'user.created', userId: 'user_alice', email: 'alice@flatout.solutions' })
    await mockValidateRequestReturning(event)

    // Webhook should NOT call BAPI for an allowed user.
    const fetchStub = vi.fn(() => Promise.resolve(new Response('', { status: 200 })))
    __setClerkFetch(fetchStub as unknown as typeof fetch)

    const webhookRes = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })
    expect(webhookRes.status).toBe(200)
    expect(fetchStub).not.toHaveBeenCalled()

    const userRow = await t.run(
      async (ctx) =>
        await ctx.db
          .query('users')
          .withIndex('byExternalId', (q) => q.eq('externalId', 'user_alice'))
          .unique()
    )
    expect(userRow?.primaryEmail).toBe('alice@flatout.solutions')

    // Authenticated query succeeds with allowed identity.
    const aliceIdentity = {
      subject: 'user_alice',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_alice',
      name: 'Alice',
      email: 'alice@flatout.solutions',
    } as const
    const subs = await t.withIdentity(aliceIdentity).query(api.subscriptions.queries.listForUser, {})
    expect(Array.isArray(subs)).toBe(true)

    // Mint succeeds.
    await mockVerifyTokenReturning({ sid: 'sess_alice', sub: 'user_alice', email: 'alice@flatout.solutions' })
    const mintFetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ jwt: 'fake-convex-jwt' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    )
    __setClerkFetch(mintFetch as unknown as typeof fetch)
    const mintResult = await t.action(internal.cli.mintAction.mintConvexJwt, {
      clerkSessionToken: 'fake',
    })
    expect(mintResult.jwt).toBe('fake-convex-jwt')
  })

  it('disallowed flow: webhook deletes via BAPI, query rejects, mint rejects', async () => {
    const t = vault()
    const event = userEvent({ type: 'user.created', userId: 'user_bob', email: 'bob@gmail.com' })
    await mockValidateRequestReturning(event)

    // BAPI DELETE responds 200.
    const deleteFetch = vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe('https://api.clerk.com/v1/users/user_bob')
      expect(init.method).toBe('DELETE')
      return Promise.resolve(new Response('', { status: 200 }))
    })
    __setClerkFetch(deleteFetch as unknown as typeof fetch)

    const webhookRes = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })
    expect(webhookRes.status).toBe(200)
    expect(deleteFetch).toHaveBeenCalledTimes(1)
    const userRow = await t.run(
      async (ctx) =>
        await ctx.db
          .query('users')
          .withIndex('byExternalId', (q) => q.eq('externalId', 'user_bob'))
          .unique()
    )
    expect(userRow).toBeNull()

    // Authenticated query with the disallowed identity throws.
    const bobIdentity = {
      subject: 'user_bob',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_bob',
      name: 'Bob',
      email: 'bob@gmail.com',
    } as const
    await expect(t.withIdentity(bobIdentity).query(api.subscriptions.queries.listForUser, {})).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|flatout\.solutions/i
    )

    // Mint with disallowed payload throws.
    await mockVerifyTokenReturning({ sid: 'sess_bob', sub: 'user_bob', email: 'bob@gmail.com' })
    await expect(t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'fake' })).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|flatout\.solutions/i
    )
  })

  it('case-insensitive boundary: Alice@FlatOut.Solutions is allowed end-to-end', async () => {
    const t = vault()
    const event = userEvent({ type: 'user.created', userId: 'user_caps', email: 'Alice@FlatOut.Solutions' })
    await mockValidateRequestReturning(event)
    const fetchStub = vi.fn(() => Promise.resolve(new Response('', { status: 200 })))
    __setClerkFetch(fetchStub as unknown as typeof fetch)
    const webhookRes = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })
    expect(webhookRes.status).toBe(200)
    expect(fetchStub).not.toHaveBeenCalled()
    const userRow = await t.run(
      async (ctx) =>
        await ctx.db
          .query('users')
          .withIndex('byExternalId', (q) => q.eq('externalId', 'user_caps'))
          .unique()
    )
    expect(userRow).not.toBeNull()
  })

  it('missing-email boundary: webhook treats missing primary email as disallowed', async () => {
    const t = vault()
    const event = {
      type: 'user.created',
      data: {
        id: 'user_nomail',
        first_name: 'No',
        last_name: 'Email',
        // No primary_email_address_id, no email_addresses match.
        primary_email_address_id: null,
        email_addresses: [],
        image_url: null,
      },
    }
    await mockValidateRequestReturning(event)
    const deleteFetch = vi.fn(() => Promise.resolve(new Response('', { status: 200 })))
    __setClerkFetch(deleteFetch as unknown as typeof fetch)

    const webhookRes = await t.fetch('/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 's' },
    })
    expect(webhookRes.status).toBe(200)
    // BAPI delete should have been called — missing email is disallowed.
    expect(deleteFetch).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run scenario test**

```
yarn test:scenario convex/__scenarios__/flatoutDomainOnly.scenario.test.ts
```

Expected: PASS, 4/4 scenarios.

If the test runner reports the file isn't picked up, check `vitest.scenario.config.ts` for the scenario glob — should be `**/*.scenario.test.ts`. Existing scenarios in `convex/__scenarios__/` match this pattern.

- [ ] **Step 3: Commit**

```bash
git add convex/__scenarios__/flatoutDomainOnly.scenario.test.ts
git commit -m "test(scenario): @flatout.solutions allowlist end-to-end coverage"
```

---

## Task 8: Manual testing docs

**Files:**

- Modify: `docs/MANUAL_TESTING.md`

- [ ] **Step 1: Add new section**

Open `docs/MANUAL_TESTING.md`. Append:

```markdown
## Email-domain allowlist (`@flatout.solutions` only)

cvault restricts account creation and access to the `@flatout.solutions` domain. Five layers enforce this; layer 1 below is manual configuration, layers 2-5 are coded.

### Layer 1 — Clerk dashboard (one-time, per environment)

1. Sign into the Clerk dashboard for the environment (dev: `clear-redbird-6.clerk.accounts.dev`; prod: production tenant).
2. Navigate to **User & Authentication → Email, Phone, Username → Restrictions**.
3. Set **Allowed email domains** to `flatout.solutions`. Save.
4. Repeat the steps above on every Clerk environment (dev, staging, prod).

This blocks signup at the source. Without it, layers 2-5 still enforce, but a non-FlatOut user briefly enters Clerk before being deleted by the webhook.

### JWT template requirement

The Convex auth wrappers read `identity.email` from the Clerk JWT. Ensure the `convex` JWT template on Clerk includes the `email` claim — Clerk's preset includes it by default, but if the template was customized, verify under **JWT templates → convex → Claims** that `email` (or `{{user.primary_email_address}}`) is present.

### Verification steps

1. **FlatOut Solutions email signup (allowed):**
   - Sign up with a `@flatout.solutions` email.
   - Dashboard renders end-to-end. Sub list, audit, machines, settings all load.
   - CLI: `cvault login` succeeds; `cvault list` returns the (empty) sub list.

2. **Wrong-domain email signup (blocked at Clerk):**
   - Try to sign up with `@gmail.com`.
   - Clerk shows the "domain not allowed" error inline before user is created. ✅

3. **Wrong-domain email if Clerk allowlist disabled (server-side fallback):**
   - Temporarily disable allowed-domains in Clerk.
   - Sign up with `@gmail.com`.
   - Clerk creates the user; webhook fires.
   - Dashboard: page reload → user is signed out (the webhook called BAPI delete). DomainGuard never gets a chance to render because the session is gone.
   - If you raced the webhook (loaded the dashboard before delete completed): DomainGuard shows the "cvault is restricted" page with a sign-out button.
   - CLI: `cvault login` fails at the mint step with `Error: Only @flatout.solutions accounts may use cvault.`
   - **Re-enable Clerk allowed-domains** before continuing.

4. **Email change after signup (rare):**
   - Sign in as `alice@flatout.solutions`. Change primary email to `alice@gmail.com` via Clerk's hosted profile UI.
   - Webhook fires `user.updated`; the BAPI delete revokes the user. Reload → signed out.

### Migration of pre-existing non-FlatOut users

If any non-FlatOut users existed before the gate landed, manually delete them in the Clerk dashboard under **Users → (filter to non-flatout.solutions) → Delete**.
```

- [ ] **Step 2: Verify markdown lint clean**

```
yarn format:check docs/MANUAL_TESTING.md
```

If it reports formatting issues:

```
yarn format:fix docs/MANUAL_TESTING.md
```

- [ ] **Step 3: Commit**

```bash
git add docs/MANUAL_TESTING.md
git commit -m "docs(manual-testing): @flatout.solutions allowlist verification steps"
```

---

## Task 9: Final verification + lint pass

- [ ] **Step 1: Full test suite**

```
yarn test
```

Expected: PASS.

- [ ] **Step 2: Scenario suite**

```
yarn test:scenario
```

Expected: PASS, all scenarios green.

- [ ] **Step 3: Integration suite (smoke)**

```
yarn test:integration
```

Expected: PASS.

- [ ] **Step 4: Type check**

```
yarn tsc -p tsconfig.app.json --noEmit
cd cli && bunx tsc --noEmit && cd ..
```

Expected: 0 errors in both.

- [ ] **Step 5: Lint**

```
yarn lint:check
```

If lint reports issues, run `yarn lint:fix` and verify the fixes are sane (no behavior changes).

- [ ] **Step 6: Format**

```
yarn format:check
```

If failed: `yarn format:fix`. Review any diff.

- [ ] **Step 7: Build**

```
yarn build
```

Expected: success, no warnings about missing imports.

- [ ] **Step 8: Commit lint/format fixes if any**

```bash
git status
# If anything changed:
git add <files>
git commit -m "chore: lint + format pass on @flatout.solutions allowlist"
```

---

## Self-review (skill-required)

After tasks 1-9 complete, walk back through:

**Spec coverage:**

- §3.2 single source of truth — Task 1 ✓
- §3.3 webhook — Task 2 ✓
- §3.4 auth wrappers — Task 3 ✓
- §3.5 mint — Task 4 ✓
- §3.6 frontend guard — Task 6 ✓
- §3.7 BAPI delete helper — Task 2 (folded in) ✓
- §5.2 modified files — Tasks 1-8 covered ✓
- §7.1 unit tests — Tasks 1-6 covered ✓
- §7.2 scenario — Task 7 ✓
- §7.3 manual docs — Task 8 ✓
- §10 risks (JWT template) — Task 8 (docs) ✓

**Type consistency:**

- `DOMAIN_REJECTION_ERROR_CODE` is `'EMAIL_DOMAIN_NOT_ALLOWED'` everywhere it's referenced.
- `isAllowedEmail` accepts `string | null | undefined` everywhere.
- `ClerkEmailDomainNotAllowedError` constructor takes a single `serverMessage: string`.

**Placeholder scan:**

- Task 5 step 6 includes a "fill from existing tests" comment — that's a deliberate guidance to read the existing harness, not a placeholder. Acceptable.
- All other code blocks are complete.

---

## PR description draft (for Task 10 = open PR)

```
fix(auth): restrict cvault to @flatout.solutions accounts

cvault is internal to FlatOut Solutions. This PR enforces that at every
authentication boundary so non-FlatOut users cannot create accounts or
access platform data.

Five layers of defense:
- Clerk dashboard (manual, documented in MANUAL_TESTING.md)
- Convex webhook deletes wrong-domain users via Clerk BAPI
- Convex authenticatedQuery/Mutation/Action wrappers reject wrong-domain identities
- CLI JWT mint route refuses wrong-domain payloads (HTTP 403)
- Frontend DomainGuard signs out wrong-domain users with a friendly error

Single source of truth in `convex/utils/domainGate.ts`.

No feature flag — restriction is permanent (per user direction).

Tests: unit coverage for each layer + end-to-end scenario in
`convex/__scenarios__/flatoutDomainOnly.scenario.test.ts`.

Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md
```
