# Allowlisted Email Domains — Implementation Plan v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict cvault account creation and platform access to email domains on the runtime allowlist (default `flatout.solutions`, configurable via dashboard UI).

**Architecture:** Five layers (Clerk dashboard manual + Convex webhook + Convex auth wrappers + CLI mint + frontend guard) all consult an `allowedEmailDomains` Convex table at request time. A pure `domainGate.ts` module holds the matching helpers; `domainGateServer.ts` / `domainGateAction.ts` wrap the table read for query/mutation/action contexts. Bootstrap fallback returns `['flatout.solutions']` when the table is empty.

**Tech Stack:** Convex (functions, http, webhooks), Clerk (`@clerk/backend`, FAPI, BAPI), TanStack Start + Clerk React, TypeScript on Bun (CLI), Vitest + convex-test + Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md`

---

## Already-landed commits on `feat/flatout-domain-only`

These are committed; do NOT redo (Tasks 3+ will modify them):

| Commit    | What                                                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `5745f74` | `convex/utils/domainGate.ts` + boundary tests (single-domain hardcoded version — Task 3 refactors to take `domains` param).                                                |
| `a1d4af0` | `convex/webhooks/clerk.ts` domain-rejection branch + `convex/cli/clerk.ts::deleteClerkUser` + tests (uses old single-domain helper — Task 6 rewires to load runtime list). |
| `9026054` | `frontend/vite.config.ts` `resolve.dedupe` fix for the React invalid-hook-call bug.                                                                                        |

## Branch + Worktree

Working in `~/.config/superpowers/worktrees/cvault/feat-flatout-domain-only` on branch `feat/flatout-domain-only`. NOT in `/Users/saadings/Desktop/cvault`.

---

## Task 3: Refactor `domainGate.ts` to take `domains` parameter

**Files:**

- Modify: `convex/utils/domainGate.ts`
- Modify: `convex/utils/domainGate.test.ts`

The module currently has `isAllowedEmail(email)` checking the hardcoded `flatout.solutions`. Refactor to take a `domains` array. Replace `ALLOWED_EMAIL_DOMAIN` with `BOOTSTRAP_ALLOWED_DOMAINS`. Add `normalizeDomain` and `isValidDomain`.

- [ ] **Step 1: Replace `convex/utils/domainGate.test.ts`**

```ts
import { describe, expect, it } from 'vitest'

import {
  BOOTSTRAP_ALLOWED_DOMAINS,
  DOMAIN_REJECTION_ERROR_CODE,
  DOMAIN_REJECTION_MESSAGE,
  isAllowedEmail,
  isValidDomain,
  normalizeDomain,
} from './domainGate'

describe('domainGate', () => {
  describe('BOOTSTRAP_ALLOWED_DOMAINS', () => {
    it('contains flatout.solutions', () => {
      expect(BOOTSTRAP_ALLOWED_DOMAINS).toContain('flatout.solutions')
    })
    it('is readonly array of lowercase strings', () => {
      for (const d of BOOTSTRAP_ALLOWED_DOMAINS) expect(d).toBe(d.toLowerCase())
    })
  })

  describe('DOMAIN_REJECTION_ERROR_CODE', () => {
    it('is EMAIL_DOMAIN_NOT_ALLOWED', () => {
      expect(DOMAIN_REJECTION_ERROR_CODE).toBe('EMAIL_DOMAIN_NOT_ALLOWED')
    })
  })

  describe('DOMAIN_REJECTION_MESSAGE', () => {
    it('mentions allowed/domain', () => {
      expect(DOMAIN_REJECTION_MESSAGE).toMatch(/domain/i)
    })
  })

  describe('isAllowedEmail', () => {
    const FLATOUT = ['flatout.solutions'] as const

    it('accepts canonical', () => {
      expect(isAllowedEmail('alice@flatout.solutions', FLATOUT)).toBe(true)
    })
    it('case-insensitive', () => {
      expect(isAllowedEmail('Alice@FlatOut.Solutions', FLATOUT)).toBe(true)
      expect(isAllowedEmail('ALICE@FLATOUT.SOLUTIONS', FLATOUT)).toBe(true)
    })
    it('plus-tag', () => {
      expect(isAllowedEmail('alice+work@flatout.solutions', FLATOUT)).toBe(true)
    })
    it('rejects different TLD', () => {
      expect(isAllowedEmail('alice@flatout.com', FLATOUT)).toBe(false)
    })
    it('rejects subdomain attack', () => {
      expect(isAllowedEmail('alice@evil.flatout.solutions', FLATOUT)).toBe(false)
    })
    it('rejects suffix attack', () => {
      expect(isAllowedEmail('alice@flatout.solutions.attacker.com', FLATOUT)).toBe(false)
    })
    it('rejects empty list', () => {
      expect(isAllowedEmail('alice@flatout.solutions', [])).toBe(false)
    })
    it('multi-domain', () => {
      const list = ['flatout.solutions', 'acme.com']
      expect(isAllowedEmail('alice@acme.com', list)).toBe(true)
      expect(isAllowedEmail('alice@flatout.solutions', list)).toBe(true)
      expect(isAllowedEmail('alice@gmail.com', list)).toBe(false)
    })
    it('rejects empty/null/undefined', () => {
      expect(isAllowedEmail('', FLATOUT)).toBe(false)
      expect(isAllowedEmail(null, FLATOUT)).toBe(false)
      expect(isAllowedEmail(undefined, FLATOUT)).toBe(false)
    })
    it('rejects malformed', () => {
      expect(isAllowedEmail('aliceflatout.solutions', FLATOUT)).toBe(false)
      expect(isAllowedEmail('alice', FLATOUT)).toBe(false)
    })
    it('rejects whitespace-padded', () => {
      expect(isAllowedEmail(' alice@flatout.solutions ', FLATOUT)).toBe(false)
    })
    it('handles uppercase domain in list (defensive)', () => {
      expect(isAllowedEmail('alice@flatout.solutions', ['FLATOUT.SOLUTIONS'])).toBe(true)
    })
  })

  describe('normalizeDomain', () => {
    it('lowercases', () => {
      expect(normalizeDomain('FlatOut.Solutions')).toBe('flatout.solutions')
    })
    it('trims', () => {
      expect(normalizeDomain('  acme.com  ')).toBe('acme.com')
    })
    it('strips leading @', () => {
      expect(normalizeDomain('@acme.com')).toBe('acme.com')
    })
    it('combo', () => {
      expect(normalizeDomain('  @ACME.com  ')).toBe('acme.com')
    })
  })

  describe('isValidDomain', () => {
    it('accepts simple', () => {
      expect(isValidDomain('acme.com')).toBe(true)
      expect(isValidDomain('flatout.solutions')).toBe(true)
      expect(isValidDomain('example.co.uk')).toBe(true)
    })
    it('rejects no dot', () => {
      expect(isValidDomain('acme')).toBe(false)
    })
    it('rejects leading @', () => {
      expect(isValidDomain('@acme.com')).toBe(false)
    })
    it('rejects double dots', () => {
      expect(isValidDomain('a..b')).toBe(false)
    })
    it('rejects spaces', () => {
      expect(isValidDomain('acme com')).toBe(false)
    })
    it('rejects empty', () => {
      expect(isValidDomain('')).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run failing tests**

```
yarn test convex/utils/domainGate.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Replace `convex/utils/domainGate.ts`**

```ts
/**
 * Domain-gate: pure helper module for the email-domain allowlist.
 *
 * No imports — keep framework-free so frontend (TanStack Start) and CLI
 * (Bun) can import without dragging Convex runtime types.
 *
 * Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §3.2
 */

export const BOOTSTRAP_ALLOWED_DOMAINS: ReadonlyArray<string> = ['flatout.solutions']

export const DOMAIN_REJECTION_ERROR_CODE = 'EMAIL_DOMAIN_NOT_ALLOWED'

export const DOMAIN_REJECTION_MESSAGE = 'Your email domain is not allowed to use cvault.'

export function isAllowedEmail(email: string | null | undefined, domains: ReadonlyArray<string>): boolean {
  if (typeof email !== 'string') return false
  if (email.length === 0) return false
  if (/\s/.test(email)) return false
  if (!email.includes('@')) return false
  const lower = email.toLowerCase()
  for (const d of domains) {
    const dLower = d.toLowerCase()
    if (dLower.length === 0) continue
    if (lower.endsWith(`@${dLower}`)) return true
  }
  return false
}

/** Lowercase, trim, strip a single leading `@`. */
export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^@/, '')
}

/**
 * Conservative domain validator. Caller should `normalizeDomain` first.
 */
export function isValidDomain(input: string): boolean {
  if (typeof input !== 'string') return false
  if (input.length === 0 || input.length > 253) return false
  if (input.startsWith('@')) return false
  if (input.includes(' ')) return false
  const labels = input.split('.')
  if (labels.length < 2) return false
  return labels.every((lbl) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(lbl))
}
```

- [ ] **Step 4: Run tests**

```
yarn test convex/utils/domainGate.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit (other tests will FAIL — expected, fixed in Tasks 5/6)**

```bash
git add convex/utils/domainGate.ts convex/utils/domainGate.test.ts
git commit -m "refactor(domain-gate): take domains list as param + add normalize/validate helpers"
```

---

## Task 4: `allowedEmailDomains` schema + queries + mutations

**Files:**

- Create: `convex/allowedDomains/schema.ts`
- Create: `convex/allowedDomains/queries.ts`
- Create: `convex/allowedDomains/mutations.ts`
- Create: `convex/allowedDomains/queries.test.ts`
- Create: `convex/allowedDomains/mutations.test.ts`
- Modify: `convex/schema.ts`

- [ ] **Step 1: Schema**

```ts
// convex/allowedDomains/schema.ts
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const allowedEmailDomainsSchema = defineTable({
  domain: v.string(),
  addedAtMs: v.number(),
  addedByUserId: v.optional(v.id('users')),
}).index('byDomain', ['domain'])
```

- [ ] **Step 2: Wire root schema**

```ts
// convex/schema.ts
import { defineSchema } from 'convex/server'

import { allowedEmailDomainsSchema } from './allowedDomains/schema'
import { machineActivitySchema } from './machineActivity/schema'
import { rateLimitSchema } from './rateLimit/schema'
import { refreshLogSchema } from './refreshLog/schema'
import { subscriptionsSchema } from './subscriptions/schema'
import { usersSchema } from './users/schema'

export default defineSchema({
  allowedEmailDomains: allowedEmailDomainsSchema,
  machineActivity: machineActivitySchema,
  rateLimit: rateLimitSchema,
  refreshLog: refreshLogSchema,
  subscriptions: subscriptionsSchema,
  users: usersSchema,
})
```

- [ ] **Step 3: Query tests**

```ts
// convex/allowedDomains/queries.test.ts
import { describe, expect, it } from 'vitest'

import { vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { BOOTSTRAP_ALLOWED_DOMAINS } from '../utils/domainGate'

describe('allowedDomains.queries', () => {
  describe('list (public)', () => {
    it('returns empty array when table empty', async () => {
      const t = vault()
      const rows = await t.query(api.allowedDomains.queries.list, {})
      expect(rows).toEqual([])
    })

    it('returns rows in domain-asc order', async () => {
      const t = vault()
      await t.run(async (ctx) => {
        await ctx.db.insert('allowedEmailDomains', { domain: 'zeta.io', addedAtMs: 100 })
        await ctx.db.insert('allowedEmailDomains', { domain: 'acme.com', addedAtMs: 200 })
      })
      const rows = await t.query(api.allowedDomains.queries.list, {})
      expect(rows.map((r) => r.domain)).toEqual(['acme.com', 'zeta.io'])
    })

    it('does not require auth', async () => {
      const t = vault()
      const rows = await t.query(api.allowedDomains.queries.list, {})
      expect(Array.isArray(rows)).toBe(true)
    })
  })

  describe('loadInternal', () => {
    it('returns BOOTSTRAP when table empty', async () => {
      const t = vault()
      const rows = await t.query(internal.allowedDomains.queries.loadInternal, {})
      expect(rows).toEqual([...BOOTSTRAP_ALLOWED_DOMAINS])
    })

    it('returns lowercased domains when non-empty', async () => {
      const t = vault()
      await t.run(async (ctx) => {
        await ctx.db.insert('allowedEmailDomains', { domain: 'ACME.com', addedAtMs: 1 })
      })
      const rows = await t.query(internal.allowedDomains.queries.loadInternal, {})
      expect(rows).toEqual(['acme.com'])
    })
  })
})
```

- [ ] **Step 4: Mutation tests**

```ts
// convex/allowedDomains/mutations.test.ts
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
      const row = await t.run(async (ctx) => await ctx.db.get(id))
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
      const fakeId = 'jd7000000000000000000000000' as never
      await expect(t.mutation(api.allowedDomains.mutations.remove, { id: fakeId })).rejects.toThrow(
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
      const row = await t.run(async (ctx) => await ctx.db.get(id))
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
  })
})
```

- [ ] **Step 5: Run failing tests**

```
yarn test convex/allowedDomains/
```

Expected: FAIL — modules don't exist yet.

- [ ] **Step 6: Implement queries**

```ts
// convex/allowedDomains/queries.ts
import { v } from 'convex/values'

import { internalQuery, query } from '../_generated/server'
import { BOOTSTRAP_ALLOWED_DOMAINS } from '../utils/domainGate'

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id('allowedEmailDomains'),
      domain: v.string(),
      addedAtMs: v.number(),
    })
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query('allowedEmailDomains').collect()
    return rows
      .map((r) => ({ _id: r._id, domain: r.domain, addedAtMs: r.addedAtMs }))
      .sort((a, b) => a.domain.localeCompare(b.domain))
  },
})

export const loadInternal = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const rows = await ctx.db.query('allowedEmailDomains').collect()
    if (rows.length === 0) return [...BOOTSTRAP_ALLOWED_DOMAINS]
    return rows.map((r) => r.domain.toLowerCase())
  },
})
```

- [ ] **Step 7: Implement mutations**

```ts
// convex/allowedDomains/mutations.ts
import { ConvexError, v } from 'convex/values'

import { authenticatedMutation, getIdentity } from '../utils/auth'
import { isValidDomain, normalizeDomain } from '../utils/domainGate'

export const add = authenticatedMutation({
  args: { domain: v.string() },
  returns: v.id('allowedEmailDomains'),
  handler: async (ctx, { domain }) => {
    const normalized = normalizeDomain(domain)
    if (!isValidDomain(normalized)) {
      throw new ConvexError({
        code: 'INVALID_DOMAIN',
        message: `'${domain}' is not a valid domain.`,
      })
    }
    const existing = await ctx.db
      .query('allowedEmailDomains')
      .withIndex('byDomain', (q) => q.eq('domain', normalized))
      .unique()
    if (existing) return existing._id

    const identity = getIdentity(ctx)
    const userRow = await ctx.db
      .query('users')
      .withIndex('byExternalId', (q) => q.eq('externalId', identity.subject))
      .unique()

    return await ctx.db.insert('allowedEmailDomains', {
      domain: normalized,
      addedAtMs: Date.now(),
      addedByUserId: userRow?._id,
    })
  },
})

export const remove = authenticatedMutation({
  args: { id: v.id('allowedEmailDomains') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id)
    if (!row) return null

    const identity = getIdentity(ctx)
    const callerEmail = typeof identity.email === 'string' ? identity.email : ''
    const callerDomain = callerEmail.split('@')[1]?.toLowerCase()
    if (callerDomain && row.domain.toLowerCase() === callerDomain) {
      throw new ConvexError({
        code: 'CANNOT_REMOVE_OWN_DOMAIN',
        message: 'You cannot remove the domain that your own email belongs to.',
      })
    }

    await ctx.db.delete(id)
    return null
  },
})
```

- [ ] **Step 8: Run tests**

```
yarn test convex/allowedDomains/
```

Expected: queries.test.ts → 5/5 PASS. mutations.test.ts → mostly FAIL because `authenticatedMutation` is the OLD wrapper that doesn't yet load runtime list. Task 5 fixes this.

- [ ] **Step 9: Commit**

```bash
git add convex/schema.ts convex/allowedDomains/
git commit -m "feat(allowed-domains): convex table + public list + add/remove mutations"
```

---

## Task 5: Auth wrappers consult runtime allowlist

**Files:**

- Create: `convex/utils/domainGateServer.ts`
- Create: `convex/utils/domainGateAction.ts`
- Modify: `convex/utils/auth.ts`
- Modify: `convex/utils/auth.test.ts`
- Modify: `convex/__tests__/helpers.ts`

- [ ] **Step 1: Update TEST_IDENTITY**

```ts
// convex/__tests__/helpers.ts (replace identity blocks)
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

Some downstream tests pass `email: 'x@example.com'` literals to mutations like `softRemove({ email })`. Those args are subscription-row emails (storage), not auth-identity emails — leave them unchanged.

- [ ] **Step 2: domainGateServer.ts**

```ts
// convex/utils/domainGateServer.ts
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import type { DataModel } from '../_generated/dataModel'
import { BOOTSTRAP_ALLOWED_DOMAINS } from './domainGate'

export async function loadAllowedDomains(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
): Promise<string[]> {
  const rows = await ctx.db.query('allowedEmailDomains').collect()
  if (rows.length === 0) return [...BOOTSTRAP_ALLOWED_DOMAINS]
  return rows.map((r) => r.domain.toLowerCase())
}
```

- [ ] **Step 3: domainGateAction.ts**

```ts
// convex/utils/domainGateAction.ts
import type { GenericActionCtx } from 'convex/server'

import { internal } from '../_generated/api'
import type { DataModel } from '../_generated/dataModel'

export async function loadAllowedDomainsFromAction(ctx: GenericActionCtx<DataModel>): Promise<string[]> {
  return await ctx.runQuery(internal.allowedDomains.queries.loadInternal, {})
}
```

- [ ] **Step 4: Append failing auth tests**

Append to `convex/utils/auth.test.ts`:

```ts
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
```

- [ ] **Step 5: Run failing tests**

```
yarn test convex/utils/auth.test.ts
```

Expected: FAIL.

- [ ] **Step 6: Replace `convex/utils/auth.ts`**

```ts
/**
 * Authenticated Convex function wrappers.
 *
 *  1. Verify ctx.auth.getUserIdentity() is non-null.
 *  2. Load runtime allowlist (allowedEmailDomains table or BOOTSTRAP).
 *  3. Verify identity.email is on the allowlist.
 *  4. Pass UserIdentity through as ctx.identity.
 *
 * Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §3.4
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
import { loadAllowedDomainsFromAction } from './domainGateAction'
import { loadAllowedDomains } from './domainGateServer'

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

function rejectDomain(): never {
  throw new ConvexError({
    code: DOMAIN_REJECTION_ERROR_CODE,
    message: DOMAIN_REJECTION_MESSAGE,
  })
}

async function resolveServer(ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new Error('Not authenticated')
  const domains = await loadAllowedDomains(ctx)
  if (!isAllowedEmail(typeof identity.email === 'string' ? identity.email : null, domains)) {
    rejectDomain()
  }
  return identity
}

async function resolveAction(ctx: GenericActionCtx<DataModel>): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new Error('Not authenticated')
  const domains = await loadAllowedDomainsFromAction(ctx)
  if (!isAllowedEmail(typeof identity.email === 'string' ? identity.email : null, domains)) {
    rejectDomain()
  }
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
      const identity = await resolveServer(ctx)
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
      const identity = await resolveServer(ctx)
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
      const identity = await resolveAction(ctx)
      return await fn.handler(Object.assign(ctx, { identity }), args as Args)
    },
  })
}) as ActionBuilder<DataModel, 'public'>
```

- [ ] **Step 7: Run full convex tests**

```
yarn test convex/
```

Expected: PASS — auth tests + allowedDomains.mutations.test.ts (which depends on the new wrapper). webhook + mintAction tests still using old isAllowedEmail signature → may FAIL; Task 6 fixes.

- [ ] **Step 8: Commit**

```bash
git add convex/__tests__/helpers.ts convex/utils/auth.ts convex/utils/auth.test.ts convex/utils/domainGateServer.ts convex/utils/domainGateAction.ts
git commit -m "feat(auth): authenticated wrappers consult runtime allowedEmailDomains"
```

---

## Task 6: Wire webhook + mintAction to runtime allowlist

**Files:**

- Modify: `convex/webhooks/clerk.ts`
- Modify: `convex/webhooks/clerk.test.ts`
- Modify: `convex/cli/mintAction.ts`
- Create: `convex/cli/mintAction.test.ts`
- Modify: `convex/cli/httpMint.ts`

- [ ] **Step 1: Update webhook**

Replace `convex/webhooks/clerk.ts`:

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
    case 'user.updated': {
      const data = event.data
      const email = primaryEmailFromUserJSON(data)
      const domains = await ctx.runQuery(internal.allowedDomains.queries.loadInternal, {})
      if (!isAllowedEmail(email, domains)) {
        const userId = data.id
        const result = await deleteClerkUser(userId)
        if (!result.ok) {
          console.error(
            `domainGate: BAPI delete failed for ${userId} (${email ?? '<missing>'}) — status=${String(result.status)}, body=${result.body.slice(0, 200)}`
          )
          return new Response('clerk delete failed', { status: 500 })
        }
        await ctx.runMutation(internal.users.actions.remove, { clerkUserId: userId })
        console.warn(`domainGate: rejected ${userId} (${email ?? '<missing>'}) — deleted via BAPI`)
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

- [ ] **Step 2: Webhook tests still work**

The existing tests pass primary emails (`alice@flatout.solutions` → allowed; `bob@gmail.com` → blocked). Both still match correct behavior with bootstrap fallback (table empty in tests → flatout allowed). Run:

```
yarn test convex/webhooks/clerk.test.ts
```

Expected: PASS, 5/5.

If a test relies on the old `isAllowedEmail(email)` 1-arg signature inline, update the test to use 2-arg form OR use the public `api.allowedDomains.queries.list` flow.

- [ ] **Step 3: Mint tests**

```ts
// convex/cli/mintAction.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'
import { __setClerkFetch } from './clerk'

const ORIG = process.env.CLERK_SECRET_KEY

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = 'sk_test_dummy'
})

afterEach(() => {
  if (ORIG === undefined) delete process.env.CLERK_SECRET_KEY
  else process.env.CLERK_SECRET_KEY = ORIG
  __setClerkFetch(undefined)
  vi.restoreAllMocks()
})

async function mockVerify(payload: object) {
  const mod = await import('@clerk/backend')
  vi.spyOn(mod, 'verifyToken').mockResolvedValue(payload as never)
}

describe('cli.mintAction.mintConvexJwt — domain gate', () => {
  it('mints when bootstrap-allowed email', async () => {
    const t = vault()
    await mockVerify({ sid: 'sess', sub: 'user_a', email: 'alice@flatout.solutions' })
    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'fake-jwt' }), { status: 200 }))
      ) as unknown as typeof fetch
    )
    const result = await t.action(internal.cli.mintAction.mintConvexJwt, {
      clerkSessionToken: 'tok',
    })
    expect(result.jwt).toBe('fake-jwt')
  })

  it('rejects wrong-domain email', async () => {
    const t = vault()
    await mockVerify({ sid: 'sess', sub: 'user_b', email: 'bob@gmail.com' })
    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'should-not' }), { status: 200 }))
      ) as unknown as typeof fetch
    )
    await expect(t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'tok' })).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )
  })

  it('rejects no-email payload', async () => {
    const t = vault()
    await mockVerify({ sid: 'sess', sub: 'user_x' })
    __setClerkFetch(vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))) as unknown as typeof fetch)
    await expect(t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'tok' })).rejects.toThrow(
      /EMAIL_DOMAIN_NOT_ALLOWED|domain/i
    )
  })

  it('accepts an added (non-bootstrap) domain', async () => {
    const t = vault()
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmailDomains', { domain: 'acme.com', addedAtMs: 1 })
    })
    await mockVerify({ sid: 'sess', sub: 'user_c', email: 'carol@acme.com' })
    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'jwt-acme' }), { status: 200 }))
      ) as unknown as typeof fetch
    )
    const result = await t.action(internal.cli.mintAction.mintConvexJwt, {
      clerkSessionToken: 'tok',
    })
    expect(result.jwt).toBe('jwt-acme')
  })
})
```

- [ ] **Step 4: Run failing tests**

```
yarn test convex/cli/mintAction.test.ts
```

Expected: FAIL.

- [ ] **Step 5: Replace mintAction.ts**

```ts
'use node'

import { verifyToken } from '@clerk/backend'
import { ConvexError, v } from 'convex/values'

import { internalAction } from '../_generated/server'
import { DOMAIN_REJECTION_ERROR_CODE, DOMAIN_REJECTION_MESSAGE, isAllowedEmail } from '../utils/domainGate'
import { loadAllowedDomainsFromAction } from '../utils/domainGateAction'
import { createSessionTokenFromTemplate } from './clerk'

export const mintConvexJwt = internalAction({
  args: { clerkSessionToken: v.string() },
  returns: v.object({ jwt: v.string() }),
  handler: async (ctx, { clerkSessionToken }): Promise<{ jwt: string }> => {
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
    const domains = await loadAllowedDomainsFromAction(ctx)
    if (!isAllowedEmail(email, domains)) {
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

- [ ] **Step 6: httpMint.ts → 403 mapping**

In `convex/cli/httpMint.ts`, update the status mapping to include `EMAIL_DOMAIN_NOT_ALLOWED → 403`. Also update the docstring `Errors:` block to mention 403.

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

- [ ] **Step 7: Run all convex tests**

```
yarn test convex/
```

Expected: PASS overall.

- [ ] **Step 8: Commit**

```bash
git add convex/webhooks/clerk.ts convex/cli/mintAction.ts convex/cli/mintAction.test.ts convex/cli/httpMint.ts
git commit -m "feat(webhook+mint): consult runtime allowedEmailDomains table"
```

---

## Task 7: CLI client recognizes 403 + friendly error

**Files:**

- Modify: `cli/src/auth/clerkFapi.ts`
- Modify: `cli/src/commands/login.ts`
- Modify: `cli/tests/auth/clerkFapi.test.ts`
- Modify: `cli/tests/commands/login.test.ts`

- [ ] **Step 1: Add ClerkEmailDomainNotAllowedError class**

After existing `ClerkSessionExpiredError` in `cli/src/auth/clerkFapi.ts`:

```ts
export class ClerkEmailDomainNotAllowedError extends Error {
  override readonly name = 'ClerkEmailDomainNotAllowedError'
  readonly serverMessage: string
  constructor(serverMessage: string) {
    super(serverMessage)
    this.serverMessage = serverMessage
  }
}
```

- [ ] **Step 2: Update mintConvexJwt to recognize 403 + EMAIL_DOMAIN_NOT_ALLOWED**

Replace the non-2xx handling block (currently throws ClerkSessionExpiredError on 401/403/404) with:

```ts
if (!res.ok) {
  const rawBody = await res.text().catch(() => '<no body>')
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

- [ ] **Step 3: Append to `cli/tests/auth/clerkFapi.test.ts`**

```ts
describe('mintConvexJwt — 403 EMAIL_DOMAIN_NOT_ALLOWED', () => {
  it('throws ClerkEmailDomainNotAllowedError on 403 + matching code', async () => {
    const session = {
      version: 1,
      clerkSessionId: 'sess',
      clerkSessionToken: 'tok',
      convexJwt: '',
      convexJwtExpiry: 0,
      frontendApiUrl: 'https://x.clerk.accounts.dev',
      convexUrl: 'https://x.convex.cloud',
      issuedAt: Math.floor(Date.now() / 1000),
    } as const
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'EMAIL_DOMAIN_NOT_ALLOWED',
            message: 'Your email domain is not allowed to use cvault.',
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        )
      )
    ) as unknown as typeof fetch
    try {
      await expect(mintConvexJwt(session)).rejects.toBeInstanceOf(ClerkEmailDomainNotAllowedError)
    } finally {
      globalThis.fetch = original
    }
  })

  it('preserves ClerkSessionExpiredError on plain 401', async () => {
    const session = {
      version: 1,
      clerkSessionId: 'sess',
      clerkSessionToken: 'tok',
      convexJwt: '',
      convexJwtExpiry: 0,
      frontendApiUrl: 'https://x.clerk.accounts.dev',
      convexUrl: 'https://x.convex.cloud',
      issuedAt: Math.floor(Date.now() / 1000),
    } as const
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'SESSION_TOKEN_INVALID' }), { status: 401 }))
    ) as unknown as typeof fetch
    try {
      await expect(mintConvexJwt(session)).rejects.toBeInstanceOf(ClerkSessionExpiredError)
    } finally {
      globalThis.fetch = original
    }
  })
})
```

Merge `ClerkEmailDomainNotAllowedError` into the existing import from `'../../src/auth/clerkFapi'`.

- [ ] **Step 4: Update `cli/src/commands/login.ts`**

Read the file first; the existing try/catch around mint/exchange handles errors. Add to the imports:

```ts
import { ClerkEmailDomainNotAllowedError } from '../auth/clerkFapi'
```

In the catch block (place above any generic console.error), add:

```ts
if (err instanceof ClerkEmailDomainNotAllowedError) {
  console.error(`Error: ${err.serverMessage}`)
  console.error('Sign out at the cvault dashboard and try again with an allowlisted email.')
  process.exit(1)
}
```

- [ ] **Step 5: login.ts test**

Read `cli/tests/commands/login.test.ts` for the harness. Add a test that mocks `exchangeTicketForSession` to throw `ClerkEmailDomainNotAllowedError` and asserts:

- `console.error` called with a domain-mentioning message.
- `process.exit(1)` called.

If the existing tests don't drive a clean entrypoint, mirror their pattern minimally (just enough to verify the catch branch is reached).

- [ ] **Step 6: Run CLI tests**

```
cd cli && bunx --bun vitest run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cli/src/auth/clerkFapi.ts cli/src/commands/login.ts cli/tests/auth/clerkFapi.test.ts cli/tests/commands/login.test.ts
git commit -m "feat(cli): surface EMAIL_DOMAIN_NOT_ALLOWED with friendly login error"
```

---

## Task 8: Frontend DomainGuard reads runtime list

**Files:**

- Create: `frontend/src/components/auth/DomainGuard.tsx`
- Create: `frontend/src/components/auth/__tests__/DomainGuard.test.tsx`
- Modify: `frontend/src/routes/__root.tsx`

- [ ] **Step 1: RTL tests (failing)**

```tsx
// frontend/src/components/auth/__tests__/DomainGuard.test.tsx
import { useClerk, useUser } from '@clerk/tanstack-react-start'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useQuery } from 'convex/react'
import { describe, expect, it, vi } from 'vitest'

import { DomainGuard } from '../DomainGuard'

vi.mock('@clerk/tanstack-react-start', () => ({
  useUser: vi.fn(),
  useClerk: vi.fn(),
}))
vi.mock('convex/react', () => ({ useQuery: vi.fn() }))

const mockedUseUser = vi.mocked(useUser)
const mockedUseClerk = vi.mocked(useClerk)
const mockedUseQuery = vi.mocked(useQuery)

function setRows(value: Array<{ _id: string; domain: string; addedAtMs: number }> | undefined) {
  mockedUseQuery.mockReturnValue(value as never)
}

describe('DomainGuard', () => {
  it('renders nothing while Clerk is loading', () => {
    mockedUseUser.mockReturnValue({ isLoaded: false, isSignedIn: false, user: null } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows([])
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
  })

  it('renders nothing while allowed-domains is loading', () => {
    mockedUseUser.mockReturnValue({ isLoaded: true, isSignedIn: true, user: null } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows(undefined)
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
  })

  it('renders children when signed out', () => {
    mockedUseUser.mockReturnValue({ isLoaded: true, isSignedIn: false, user: null } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows([])
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.getByText('protected')).toBeInTheDocument()
  })

  it('signed in + allowed (bootstrap fallback)', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'alice@flatout.solutions' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows([])
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.getByText('protected')).toBeInTheDocument()
  })

  it('signed in + matches a configured (non-bootstrap) domain', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'bob@acme.com' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows([{ _id: '1', domain: 'acme.com', addedAtMs: 1 }])
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.getByText('protected')).toBeInTheDocument()
  })

  it('signed in + disallowed → blocked page', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'eve@gmail.com' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows([{ _id: '1', domain: 'flatout.solutions', addedAtMs: 1 }])
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
    expect(screen.getByText(/cvault is restricted/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument()
  })

  it('sign-out button calls Clerk signOut', async () => {
    const signOut = vi.fn()
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'eve@gmail.com' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut } as never)
    setRows([])
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }))
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('user with no primary email → blocked', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: null },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows([])
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
  })
})
```

- [ ] **Step 2: Run failing tests**

```
yarn test frontend/src/components/auth/__tests__/DomainGuard.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement DomainGuard**

```tsx
// frontend/src/components/auth/DomainGuard.tsx
import { useClerk, useUser } from '@clerk/tanstack-react-start'
import { useQuery } from 'convex/react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'

import { api } from '../../../../convex/_generated/api'
import { BOOTSTRAP_ALLOWED_DOMAINS, isAllowedEmail } from '../../../../convex/utils/domainGate'

export function DomainGuard({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, user } = useUser()
  const { signOut } = useClerk()
  const allowedRows = useQuery(api.allowedDomains.queries.list, {})

  if (!isLoaded || allowedRows === undefined) return null

  const domains =
    allowedRows.length > 0 ? allowedRows.map((r) => r.domain.toLowerCase()) : [...BOOTSTRAP_ALLOWED_DOMAINS]

  if (!isSignedIn) return <>{children}</>

  const email = user?.primaryEmailAddress?.emailAddress ?? null
  if (isAllowedEmail(email, domains)) return <>{children}</>

  return <DomainBlocked onSignOut={() => void signOut()} email={email} domains={domains} />
}

function DomainBlocked({
  onSignOut,
  email,
  domains,
}: {
  onSignOut: () => void
  email: string | null
  domains: string[]
}) {
  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">cvault is restricted</h1>
        <p className="text-muted-foreground mt-2 max-w-md text-sm">
          Your account{email ? ` (${email})` : ''} is not on the cvault allowlist. Allowed domains:{' '}
          {domains.map((d) => (
            <code key={d} className="bg-muted mx-0.5 rounded px-1 py-0.5 text-xs">
              @{d}
            </code>
          ))}
          .
        </p>
      </div>
      <Button onClick={onSignOut} size="lg" variant="default">
        Sign out
      </Button>
    </div>
  )
}
```

- [ ] **Step 4: Wire \_\_root.tsx**

In `frontend/src/routes/__root.tsx`, add:

```ts
import { DomainGuard } from '../components/auth/DomainGuard'
```

Wrap `<Outlet />` inside the existing providers:

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

- [ ] **Step 5: Run frontend tests**

```
yarn test frontend/
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/auth/ frontend/src/routes/__root.tsx
git commit -m "feat(frontend): DomainGuard reads runtime allowedDomains list"
```

---

## Task 9: Settings UI page

**Files:**

- Create: `frontend/src/routes/dashboard/settings/domains.lazy.tsx`
- Create: `frontend/src/__tests__/routes/settingsDomains.test.tsx`
- Modify: `frontend/src/routes/dashboard/settings.lazy.tsx`

- [ ] **Step 1: Read existing settings.lazy.tsx**

Note its style (cards, typography). Match it.

- [ ] **Step 2: Failing RTL tests**

```tsx
// frontend/src/__tests__/routes/settingsDomains.test.tsx
import { useUser } from '@clerk/tanstack-react-start'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMutation, useQuery } from 'convex/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DomainsPage } from '../../routes/dashboard/settings/domains.lazy'

vi.mock('@clerk/tanstack-react-start', () => ({ useUser: vi.fn() }))
vi.mock('convex/react', () => ({ useQuery: vi.fn(), useMutation: vi.fn() }))

const mockedUseUser = vi.mocked(useUser)
const mockedUseQuery = vi.mocked(useQuery)
const mockedUseMutation = vi.mocked(useMutation)

let addMock = vi.fn()
let removeMock = vi.fn()

beforeEach(() => {
  addMock = vi.fn(() => Promise.resolve('jd_new_id'))
  removeMock = vi.fn(() => Promise.resolve(null))
  mockedUseMutation.mockImplementation((ref) => {
    const refStr = String(ref)
    if (refStr.includes('add')) return addMock as never
    if (refStr.includes('remove')) return removeMock as never
    return vi.fn() as never
  })
  mockedUseUser.mockReturnValue({
    user: { primaryEmailAddress: { emailAddress: 'alice@flatout.solutions' } },
  } as never)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('DomainsPage', () => {
  it('renders the current allowlist', () => {
    mockedUseQuery.mockReturnValue([
      { _id: '1', domain: 'flatout.solutions', addedAtMs: 1 },
      { _id: '2', domain: 'acme.com', addedAtMs: 2 },
    ] as never)
    render(<DomainsPage />)
    expect(screen.getByText('flatout.solutions')).toBeInTheDocument()
    expect(screen.getByText('acme.com')).toBeInTheDocument()
  })

  it('shows bootstrap-active hint when empty', () => {
    mockedUseQuery.mockReturnValue([] as never)
    render(<DomainsPage />)
    expect(screen.getByText(/bootstrap fallback/i)).toBeInTheDocument()
  })

  it('add submits the typed domain', async () => {
    mockedUseQuery.mockReturnValue([] as never)
    render(<DomainsPage />)
    const input = screen.getByLabelText(/add domain/i)
    await userEvent.type(input, '  ACME.COM ')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(addMock).toHaveBeenCalledWith({ domain: '  ACME.COM ' })
  })

  it('remove asks for confirmation then calls mutation', async () => {
    mockedUseQuery.mockReturnValue([{ _id: '1', domain: 'acme.com', addedAtMs: 1 }] as never)
    render(<DomainsPage />)
    await userEvent.click(screen.getByRole('button', { name: /remove acme\.com/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm/i }))
    expect(removeMock).toHaveBeenCalledWith({ id: '1' })
  })

  it('disables remove on the row matching caller domain', () => {
    mockedUseQuery.mockReturnValue([
      { _id: '1', domain: 'flatout.solutions', addedAtMs: 1 },
      { _id: '2', domain: 'acme.com', addedAtMs: 2 },
    ] as never)
    render(<DomainsPage />)
    const flatBtn = screen.getByRole('button', { name: /remove flatout\.solutions/i })
    expect(flatBtn).toBeDisabled()
    const acmeBtn = screen.getByRole('button', { name: /remove acme\.com/i })
    expect(acmeBtn).not.toBeDisabled()
  })

  it('surfaces server validation error on add', async () => {
    addMock = vi.fn(() => {
      throw new Error('INVALID_DOMAIN: not a valid domain')
    })
    mockedUseMutation.mockImplementation((ref) => {
      const refStr = String(ref)
      if (refStr.includes('add')) return addMock as never
      return vi.fn() as never
    })
    mockedUseQuery.mockReturnValue([] as never)
    render(<DomainsPage />)
    await userEvent.type(screen.getByLabelText(/add domain/i), 'not a domain')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(await screen.findByText(/INVALID_DOMAIN/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run failing tests**

```
yarn test frontend/src/__tests__/routes/settingsDomains.test.tsx
```

Expected: FAIL.

- [ ] **Step 4: Implement page**

```tsx
// frontend/src/routes/dashboard/settings/domains.lazy.tsx
import { useUser } from '@clerk/tanstack-react-start'
import { createLazyFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { api } from '../../../../../convex/_generated/api'
import type { Id } from '../../../../../convex/_generated/dataModel'

export const Route = createLazyFileRoute('/dashboard/settings/domains')({
  component: DomainsPage,
})

export function DomainsPage() {
  const { user } = useUser()
  const callerEmail = user?.primaryEmailAddress?.emailAddress ?? ''
  const callerDomain = callerEmail.split('@')[1]?.toLowerCase()

  const rows = useQuery(api.allowedDomains.queries.list, {})
  const add = useMutation(api.allowedDomains.mutations.add)
  const remove = useMutation(api.allowedDomains.mutations.remove)

  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendingRemoveId, setPendingRemoveId] = useState<Id<'allowedEmailDomains'> | null>(null)
  const [pendingRemoveDomain, setPendingRemoveDomain] = useState<string>('')

  async function onAdd(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (draft.trim().length === 0) return
    try {
      await add({ domain: draft })
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onConfirmRemove() {
    if (!pendingRemoveId) return
    setError(null)
    try {
      await remove({ id: pendingRemoveId })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingRemoveId(null)
      setPendingRemoveDomain('')
    }
  }

  if (rows === undefined) {
    return <div className="text-muted-foreground p-6 text-sm">Loading…</div>
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Allowed email domains</h1>
        <p className="text-muted-foreground text-sm">
          Anyone with a primary email on these domains can sign in to cvault. Empty list falls back to{' '}
          <code className="bg-muted rounded px-1">flatout.solutions</code>.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="border-border bg-card rounded-lg border p-4 text-sm">
          No domains configured. Bootstrap fallback (<code className="bg-muted rounded px-1">flatout.solutions</code>)
          is active. Add a domain to take control of the allowlist.
        </div>
      ) : (
        <ul className="border-border bg-card divide-border divide-y rounded-lg border">
          {rows.map((r) => {
            const isOwn = callerDomain && r.domain.toLowerCase() === callerDomain
            return (
              <li key={r._id} className="flex items-center justify-between p-3">
                <span className="font-mono text-sm">{r.domain}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(isOwn)}
                  onClick={() => {
                    setPendingRemoveId(r._id)
                    setPendingRemoveDomain(r.domain)
                  }}
                  aria-label={`Remove ${r.domain}`}
                  title={isOwn ? 'You cannot remove your own domain' : undefined}
                >
                  Remove
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <form onSubmit={onAdd} className="flex flex-col gap-2">
        <Label htmlFor="add-domain">Add domain</Label>
        <div className="flex items-center gap-2">
          <Input
            id="add-domain"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="acme.com"
            className="max-w-xs"
          />
          <Button type="submit" size="sm">
            Add
          </Button>
        </div>
      </form>

      {error !== null && (
        <div className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm" role="alert">
          {error}
        </div>
      )}

      <Dialog open={pendingRemoveId !== null} onOpenChange={(o) => !o && setPendingRemoveId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove allowed domain?</DialogTitle>
            <DialogDescription>
              Removing <code className="bg-muted rounded px-1">{pendingRemoveDomain}</code> will revoke access for users
              with this email domain on their next sign-in.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button variant="default" size="sm" onClick={onConfirmRemove}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
```

- [ ] **Step 5: Wire link from settings.lazy.tsx**

Add a card / link inside `frontend/src/routes/dashboard/settings.lazy.tsx` matching the existing style. Minimal:

```tsx
import { Link } from '@tanstack/react-router'

// ...

;<Link to="/dashboard/settings/domains" className="text-primary hover:underline text-sm">
  Manage allowed email domains →
</Link>
```

Place it inside the existing settings layout where it fits stylistically.

- [ ] **Step 6: Run tests**

```
yarn test frontend/
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/routes/dashboard/settings frontend/src/routes/dashboard/settings.lazy.tsx frontend/src/__tests__/routes/settingsDomains.test.tsx
git commit -m "feat(frontend): /dashboard/settings/domains UI for managing allowlist"
```

---

## Task 10: End-to-end scenario test

**Files:**

- Create: `convex/__scenarios__/flatoutDomainOnly.scenario.test.ts`

- [ ] **Step 1: Write scenario**

```ts
// convex/__scenarios__/flatoutDomainOnly.scenario.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { __setClerkFetch } from '../cli/clerk'

const ORIGINAL_KEY = process.env.CLERK_SECRET_KEY
const ORIGINAL_HOOK = process.env.CLERK_WEBHOOK_SECRET

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = 'sk_test_dummy'
  process.env.CLERK_WEBHOOK_SECRET = 'whsec_dummy'
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.CLERK_SECRET_KEY
  else process.env.CLERK_SECRET_KEY = ORIGINAL_KEY
  if (ORIGINAL_HOOK === undefined) delete process.env.CLERK_WEBHOOK_SECRET
  else process.env.CLERK_WEBHOOK_SECRET = ORIGINAL_HOOK
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

async function mockVerify(payload: object) {
  const mod = await import('@clerk/backend')
  vi.spyOn(mod, 'verifyToken').mockResolvedValue(payload as never)
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

    await mockVerify({ sid: 'sess', sub: 'user_alice', email: 'alice@flatout.solutions' })
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

    await mockVerify({ sid: 'sess', sub: 'user_bob', email: 'bob@gmail.com' })
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
    let flatoutId: never
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        externalId: TEST_IDENTITY.subject,
        name: TEST_IDENTITY.name,
        primaryEmail: TEST_IDENTITY.email,
        otherEmails: [],
      })
      flatoutId = (await ctx.db.insert('allowedEmailDomains', {
        domain: 'flatout.solutions',
        addedAtMs: 1,
      })) as never
    })
    await expect(
      t.withIdentity(TEST_IDENTITY).mutation(api.allowedDomains.mutations.remove, { id: flatoutId! })
    ).rejects.toThrow(/CANNOT_REMOVE_OWN_DOMAIN/i)
  })
})
```

- [ ] **Step 2: Run scenario**

```
yarn test:scenario convex/__scenarios__/flatoutDomainOnly.scenario.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 3: Commit**

```bash
git add convex/__scenarios__/flatoutDomainOnly.scenario.test.ts
git commit -m "test(scenario): runtime allowlist end-to-end (bootstrap + dynamic + self-removal)"
```

---

## Task 11: Manual testing docs

**Files:**

- Modify: `docs/MANUAL_TESTING.md`

- [ ] **Step 1: Append section**

```markdown
## Email-domain allowlist (UI-configurable)

cvault restricts account creation and access to email domains on the runtime allowlist (Convex `allowedEmailDomains` table). Five layers enforce:

1. **Clerk dashboard** — set "Allowed email domains" to match cvault's allowlist (manual; one-time per env).
2. **Convex webhook** — deletes wrong-domain users via Clerk BAPI.
3. **Convex auth wrappers** — every authenticated query/mutation/action consults the runtime list.
4. **CLI JWT mint** — refuses mint for non-allowlisted emails (HTTP 403).
5. **Frontend `DomainGuard`** — UX layer that signs out wrong-domain users.

### JWT template requirement

The `convex` JWT template on Clerk must include the `email` claim. Verify under **JWT templates → convex → Claims** that `email` is present (it is by default).

### Bootstrap fallback

When `allowedEmailDomains` is empty, the system falls back to `['flatout.solutions']`. So a fresh deployment Just Works for FlatOut accounts.

### Managing the allowlist (UI)

1. Sign in with an allowlisted email.
2. Visit `/dashboard/settings/domains`.
3. Click "Add" with a domain (e.g. `acme.com`); the form normalizes (lowercase, strip `@`).
4. Click "Remove" on any row except your own (the row containing your domain is disabled).
5. Confirm in the dialog.

### Verification steps

1. **Allowed signup:** sign up with `@flatout.solutions` (or any added domain) → dashboard renders.
2. **Wrong-domain blocked at Clerk:** if Clerk dashboard "Allowed domains" set, signup is blocked there.
3. **Wrong-domain (Clerk allowlist disabled):** signup succeeds at Clerk; cvault webhook deletes the user; reload → signed-out CTA.
4. **CLI:** `cvault login` with FlatOut session → success. With non-allowlisted session → "Your email domain is not allowed to use cvault." printed; exit 1.
5. **Settings UI:** Add `acme.com`. Sign up `bob@acme.com` → dashboard works. Remove `acme.com` → bob blocked on next page load.
6. **Self-removal block:** as alice@flatout.solutions, try to remove `flatout.solutions` from the UI when it's the only row → server rejects with `CANNOT_REMOVE_OWN_DOMAIN`.

### Migration of pre-existing wrong-domain users

If any non-allowlisted users existed before the gate landed, manually delete them in the Clerk dashboard.
```

- [ ] **Step 2: Format**

```
yarn format:check docs/MANUAL_TESTING.md
```

Run `yarn format:fix docs/MANUAL_TESTING.md` if needed.

- [ ] **Step 3: Commit**

```bash
git add docs/MANUAL_TESTING.md
git commit -m "docs(manual-testing): UI-configurable allowlist verification steps"
```

---

## Task 12: Final verification

- [ ] **Step 1: All test suites**

```
yarn test
yarn test:scenario
yarn test:integration
```

PASS.

- [ ] **Step 2: Type checks**

```
yarn tsc -p tsconfig.app.json --noEmit
cd cli && bunx tsc --noEmit && cd ..
```

0 errors.

- [ ] **Step 3: Lint + format**

```
yarn lint:check
yarn format:check
```

If anything fails, run `:fix` variants and review.

- [ ] **Step 4: Build**

```
yarn build
```

Succeeds.

- [ ] **Step 5: Commit any lint/format diffs**

```bash
git status
git add <files-if-any>
git commit -m "chore: lint + format pass on allowlist feature"
```

---

## Self-review checklist

- §3.2 single source of truth — Tasks 3, 5 ✓
- §3.2.1 schema — Task 4 ✓
- §3.2.2 bootstrap fallback — Tasks 4, 5 ✓
- §3.2.3 public API — Task 4 ✓
- §3.3 webhook — Tasks 2 (already), 6 (rewire) ✓
- §3.4 auth wrappers — Task 5 ✓
- §3.5 mint — Task 6 ✓
- §3.6 frontend guard — Task 8 ✓
- §3.6.1 settings UI — Task 9 ✓
- §3.6.2 self-removal — Tasks 4, 9 ✓
- §3.7 BAPI delete helper — already in `a1d4af0` ✓
- React hook fix — already in `9026054` ✓
- §7.1 unit tests — Tasks 3, 4, 5, 6, 8, 9 ✓
- §7.2 scenario — Task 10 ✓
- §7.3 manual docs — Task 11 ✓
