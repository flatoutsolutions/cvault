# Per-Email Allowlist + Domain UI Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow specific email addresses through the cvault gate (e.g. `samuel.asseg@gmail.com`) without opening up an entire domain (e.g. `gmail.com`). Run a per-email allowlist in parallel with the existing domain allowlist; an email passes if either matches. Plus: fix the domain settings UI route, which is registered without the static-route stub that every other dashboard route in the repo has, so the route does not reliably navigate.

**Architecture:** Mirror the existing `allowedEmailDomains` subsystem with a sibling `allowedEmails` subsystem (table + schema + queries + mutations). Extend the pure `domainGate.ts` helper with `normalizeEmail`/`isValidEmail` and a 3rd argument to `isAllowedEmail`. Webhook + DomainGuard read both lists and pass them. Add the missing static `domains.tsx` stub to fix the routing bug and apply the same convention to a new `emails.tsx` + `emails.lazy.tsx` pair.

**Tech Stack:** Convex (functions, http, webhooks), Clerk webhooks via `@clerk/backend`, TanStack Router (file-based routes with `createFileRoute`/`createLazyFileRoute`), TanStack Form + React Hook Form + Zod, ShadCN UI, Vitest + convex-test + Testing Library.

**Spec:** Companion to `docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md`. The per-email allowlist relaxes the spec's §2 non-goal "Per-user / individual-email allowlist" — the user has explicitly requested this functionality.

---

## Approach + Justifications

### Why a separate `allowedEmails` table

Mirror, do not co-mingle. Reasons:

1. **Different schema constraints** — emails need full-string canonical form (lowercased, trimmed, valid `@`-form). Domains need a different validator (`isValidDomain`).
2. **Different UX** — separate settings page lets the admin reason about "allow exactly this person" vs "allow this whole org".
3. **Easier audit** — list of explicit exceptions is its own report.
4. **Defense in depth (parallel-code-paths rule):** every consumer of the domain list must pass the email list too. Audit each call site instead of overloading semantics.

### Why one shared error code (`EMAIL_NOT_ALLOWED`)

Two new user-facing rejections (one for the new email gate, one for the old domain gate) would be redundant — the user does not care _why_ they're blocked, only _that_ they are blocked. Reuse one shared `EMAIL_DOMAIN_NOT_ALLOWED` code from the existing helper. We add an `EMAIL_INVALID` code for the validator so the form can render a precise message at add-time.

Trade-off: if a future caller wants different blocked-page copy for "your specific email is blocked" vs "your domain is blocked", we revisit. YAGNI for now.

### Why backward-compatible signature on `isAllowedEmail`

Existing callers pass `(email, domains)`. Making `emails` optional with default `[]` keeps the helper drop-in compatible with old call sites that have not been updated yet, and keeps the `domainGate.test.ts` two-arg cases all valid. New call sites pass both. Migration is a one-pass audit of the four known call sites (auth wrappers, mintAction, webhook, DomainGuard).

### Why `extractEmailDomain` lastIndexOf for normalization

Identical reasoning to the existing `domainGate.ts` discussion — multi-`@` emails resolve to the LAST `@` so the normalized form matches the suffix-match boundary. Same hands-off semantics — `normalizeEmail` only lowercases + trims; it does not rewrite the local part or strip plus-tags. Plus-tagged emails are distinct addresses and must be added explicitly.

### Why the domain UI bug is the missing static stub

`frontend/src/routes/dashboard/settings/domains.lazy.tsx` exists but `frontend/src/routes/dashboard/settings/domains.tsx` does not. Every other dashboard route in the repo pairs `<route>.tsx` (calls `createFileRoute('/dashboard/<x>')({})`) with `<route>.lazy.tsx` (calls `createLazyFileRoute('/dashboard/<x>')({ component: ... })`).

Without the static stub, TanStack Router's codegen synthesizes a placeholder `createFileRoute('/dashboard/settings/domains')()` at the top of `routeTree.gen.ts` (line 22). That works in some cases but not reliably for prerendered routes — the `tanstackStart` plugin's `crawlLinks: true` prerender pass needs a real source-of-truth file route to discover and prerender. Adding the static stub aligns with the convention of every other route and unblocks the route registration.

### Bootstrap allowed emails

Default `BOOTSTRAP_ALLOWED_EMAILS = []`. Per the user's instruction, do **not** seed `samuel.asseg@gmail.com` or any specific personal address into the codebase. The user's plan is to add it via the UI post-deploy. We provide a one-liner Convex CLI command in the PR description for immediate insertion if the user prefers.

### File map

**New files (backend):**

- `convex/allowedEmails/schema.ts` — table def
- `convex/allowedEmails/mutations.ts` — `add`, `remove`
- `convex/allowedEmails/queries.ts` — `list`, `loadInternal`
- `convex/allowedEmails/mutations.test.ts`
- `convex/allowedEmails/queries.test.ts`
- `convex/__scenarios__/perEmailAllowlist.scenario.test.ts`

**New files (frontend):**

- `frontend/src/routes/dashboard/settings/emails.tsx` — static stub
- `frontend/src/routes/dashboard/settings/emails.lazy.tsx` — page component
- `frontend/src/routes/dashboard/settings/domains.tsx` — static stub (BUG FIX)

**Modified files (backend):**

- `convex/utils/domainGate.ts` — add `BOOTSTRAP_ALLOWED_EMAILS`, `normalizeEmail`, `isValidEmail`; extend `isAllowedEmail(email, domains, emails?)`
- `convex/utils/domainGate.test.ts` — extend tests
- `convex/utils/domainGateServer.ts` — add `loadAllowedEmails(ctx)`
- `convex/utils/domainGateAction.ts` — add `loadAllowedEmailsFromAction(ctx)`
- `convex/utils/auth.ts` — extend `resolveServer`/`resolveAction` to load+pass emails
- `convex/utils/auth.test.ts` — add explicit-email accept tests
- `convex/cli/mintAction.ts` — load+pass emails
- `convex/cli/mintAction.test.ts` — add explicit-email tests
- `convex/webhooks/clerk.ts` — load+pass emails
- `convex/webhooks/clerk.test.ts` — add explicit-email accept test
- `convex/schema.ts` — register `allowedEmails` table

**Modified files (frontend):**

- `frontend/src/components/auth/DomainGuard.tsx` — load+pass emails
- `frontend/src/routes/dashboard/settings.lazy.tsx` — link to `/dashboard/settings/emails` next to domains link
- `frontend/src/routeTree.gen.ts` — regenerated by TanStack Router (do not hand edit)

---

## Branch + Worktree

Working on branch `feat/per-email-allowlist` rooted in `/Users/saadings/Desktop/cvault`. Branch has no upstream tracking — global rule: feature branches must not track origin/main.

---

## Task 1: Domain UI route fix (the foundational bug)

**Files:**

- Create: `frontend/src/routes/dashboard/settings/domains.tsx`

The bug: `domains.lazy.tsx` exists but the partner `domains.tsx` static stub is missing. Every other dashboard route in the repo follows the `<x>.tsx` + `<x>.lazy.tsx` pair convention. The TanStack Router codegen synthesizes a placeholder when a `.lazy.tsx` is missing its partner, but that path is unreliable for prerendered routes (and inconsistent with the rest of the codebase). Adding the static stub is the root-cause fix.

- [ ] **Step 1: Write the static stub**

```tsx
/**
 * /dashboard/settings/domains — static route declaration.
 *
 * Pairs with `domains.lazy.tsx` (page component). Every dashboard route
 * in this repo follows the `.tsx` (static stub) + `.lazy.tsx` (component)
 * convention. Without this stub, TanStack Router's codegen synthesizes a
 * placeholder `createFileRoute('/dashboard/settings/domains')()` at the
 * top of routeTree.gen.ts — which works in dev but is unreliable for
 * prerendered routes (`tanstackStart` plugin with `crawlLinks: true`).
 */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/dashboard/settings/domains')({})
```

- [ ] **Step 2: Regenerate route tree**

Run: `cd frontend && yarn tsr generate` (or rely on the dev server's plugin)
Expected: `frontend/src/routeTree.gen.ts` no longer contains the synthesized `DashboardSettingsDomainsLazyRouteImport = createFileRoute(...)` placeholder; it imports the new stub instead.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/routes/dashboard/settings/domains.tsx frontend/src/routeTree.gen.ts
git commit -m "fix(frontend): add missing static route stub for /dashboard/settings/domains"
```

---

## Task 2: Add `BOOTSTRAP_ALLOWED_EMAILS` + `normalizeEmail` + `isValidEmail`

**Files:**

- Modify: `convex/utils/domainGate.ts`
- Modify: `convex/utils/domainGate.test.ts`

- [ ] **Step 1: Add tests for `normalizeEmail`**

In `convex/utils/domainGate.test.ts`, add inside the existing `describe('domainGate')`:

```ts
describe('BOOTSTRAP_ALLOWED_EMAILS', () => {
  it('is empty by default — admins use the UI/CLI to seed', () => {
    expect(BOOTSTRAP_ALLOWED_EMAILS).toEqual([])
  })
  it('is a readonly array of lowercase strings', () => {
    for (const e of BOOTSTRAP_ALLOWED_EMAILS) expect(e).toBe(e.toLowerCase())
  })
})

describe('normalizeEmail', () => {
  it('lowercases', () => {
    expect(normalizeEmail('Alice@FlatOut.Solutions')).toBe('alice@flatout.solutions')
  })
  it('trims', () => {
    expect(normalizeEmail('  alice@acme.com  ')).toBe('alice@acme.com')
  })
  it('combo', () => {
    expect(normalizeEmail('  ALICE@ACME.com  ')).toBe('alice@acme.com')
  })
})

describe('isValidEmail', () => {
  it('accepts canonical', () => {
    expect(isValidEmail('alice@flatout.solutions')).toBe(true)
    expect(isValidEmail('a.b+tag@example.co.uk')).toBe(true)
  })
  it('rejects empty', () => {
    expect(isValidEmail('')).toBe(false)
  })
  it('rejects no @', () => {
    expect(isValidEmail('aliceflatout.solutions')).toBe(false)
  })
  it('rejects multiple @', () => {
    expect(isValidEmail('a@b@flatout.solutions')).toBe(false)
  })
  it('rejects empty local', () => {
    expect(isValidEmail('@flatout.solutions')).toBe(false)
  })
  it('rejects empty domain', () => {
    expect(isValidEmail('alice@')).toBe(false)
  })
  it('rejects invalid domain', () => {
    expect(isValidEmail('alice@no-dot')).toBe(false)
    expect(isValidEmail('alice@a..b')).toBe(false)
  })
  it('rejects whitespace', () => {
    expect(isValidEmail('al ice@acme.com')).toBe(false)
    expect(isValidEmail('alice@acme com')).toBe(false)
  })
})
```

Add the new symbols to the import:

```ts
import {
  BOOTSTRAP_ALLOWED_DOMAINS,
  BOOTSTRAP_ALLOWED_EMAILS,
  DOMAIN_REJECTION_ERROR_CODE,
  DOMAIN_REJECTION_MESSAGE,
  extractEmailDomain,
  isAllowedEmail,
  isValidDomain,
  isValidEmail,
  normalizeDomain,
  normalizeEmail,
} from './domainGate'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test convex/utils/domainGate.test.ts`
Expected: failures complaining `BOOTSTRAP_ALLOWED_EMAILS`, `normalizeEmail`, `isValidEmail` are not exported.

- [ ] **Step 3: Implement the new exports in `convex/utils/domainGate.ts`**

Add at the bottom (do not touch existing exports):

```ts
/**
 * Bootstrap allowlist of explicit emails. Empty by default — admins seed
 * via the dashboard UI or via a one-off `npx convex run` mutation. This
 * exists so server helpers can return a stable shape when the table is
 * empty (matches the BOOTSTRAP_ALLOWED_DOMAINS pattern).
 */
export const BOOTSTRAP_ALLOWED_EMAILS: ReadonlyArray<string> = []

/** Lowercase + trim. Defensive — does NOT alter the local-part beyond casing. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase()
}

/**
 * Conservative email validator. Caller should `normalizeEmail` first.
 * Rules:
 *  - non-empty
 *  - contains exactly one '@'
 *  - non-empty local part with no whitespace
 *  - domain part passes `isValidDomain`
 *
 * NOTE: this is intentionally stricter than RFC 5321 — we reject quoted
 * local-parts and multi-@ addresses because the gate's matching boundary
 * uses lastIndexOf semantics. Quoted local-parts are exotic; if a real
 * user shows up needing one we revisit.
 */
export function isValidEmail(input: string): boolean {
  if (typeof input !== 'string') return false
  if (input.length === 0) return false
  if (/\s/.test(input)) return false
  const at = input.indexOf('@')
  if (at < 0) return false
  if (input.indexOf('@', at + 1) >= 0) return false // multiple '@'
  const local = input.slice(0, at)
  const domain = input.slice(at + 1)
  if (local.length === 0) return false
  if (domain.length === 0) return false
  return isValidDomain(domain)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test convex/utils/domainGate.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add convex/utils/domainGate.ts convex/utils/domainGate.test.ts
git commit -m "feat(convex): add normalizeEmail, isValidEmail, BOOTSTRAP_ALLOWED_EMAILS helpers"
```

---

## Task 3: Extend `isAllowedEmail` to accept explicit-email list

**Files:**

- Modify: `convex/utils/domainGate.ts`
- Modify: `convex/utils/domainGate.test.ts`

- [ ] **Step 1: Add failing tests for the new `emails` parameter**

In `convex/utils/domainGate.test.ts`, append inside the existing `describe('isAllowedEmail')`:

```ts
it('accepts when email exact-matches an entry in the explicit emails list', () => {
  expect(isAllowedEmail('samuel.asseg@gmail.com', [], ['samuel.asseg@gmail.com'])).toBe(true)
})
it('explicit-email match is case-insensitive', () => {
  expect(isAllowedEmail('Samuel.Asseg@Gmail.Com', [], ['samuel.asseg@gmail.com'])).toBe(true)
  expect(isAllowedEmail('samuel.asseg@gmail.com', [], ['SAMUEL.ASSEG@GMAIL.COM'])).toBe(true)
})
it('explicit-email mismatch falls through (no domain match) → false', () => {
  expect(isAllowedEmail('not.samuel@gmail.com', [], ['samuel.asseg@gmail.com'])).toBe(false)
})
it('domain match still works when emails list is non-empty', () => {
  expect(isAllowedEmail('alice@flatout.solutions', ['flatout.solutions'], ['samuel.asseg@gmail.com'])).toBe(true)
})
it('emails list defaults to [] when omitted (backward-compat)', () => {
  expect(isAllowedEmail('alice@flatout.solutions', ['flatout.solutions'])).toBe(true)
  expect(isAllowedEmail('samuel.asseg@gmail.com', ['flatout.solutions'])).toBe(false)
})
it('plus-tagged email NOT auto-matched against bare explicit entry (strict)', () => {
  // Explicit allowlist semantics: 'samuel.asseg@gmail.com' allows only that
  // address, NOT 'samuel.asseg+work@gmail.com'. If admins want plus-tag
  // tolerance, they add the plus-tag form too.
  expect(isAllowedEmail('samuel.asseg+work@gmail.com', [], ['samuel.asseg@gmail.com'])).toBe(false)
})
it('whitespace-padded input is rejected (regression with explicit-email list)', () => {
  expect(isAllowedEmail(' samuel.asseg@gmail.com ', [], ['samuel.asseg@gmail.com'])).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test convex/utils/domainGate.test.ts`
Expected: 7 new failures — `isAllowedEmail` only accepts 2 args today.

- [ ] **Step 3: Update `isAllowedEmail` signature + body**

In `convex/utils/domainGate.ts`, replace the existing `isAllowedEmail` with:

```ts
export function isAllowedEmail(
  email: string | null | undefined,
  domains: ReadonlyArray<string>,
  emails: ReadonlyArray<string> = []
): boolean {
  if (typeof email !== 'string') return false
  if (email.length === 0) return false
  if (/\s/.test(email)) return false
  if (!email.includes('@')) return false
  const lower = email.toLowerCase()
  for (const e of emails) {
    if (typeof e !== 'string') continue
    if (e.length === 0) continue
    if (lower === e.toLowerCase()) return true
  }
  for (const d of domains) {
    const dLower = d.toLowerCase()
    if (dLower.length === 0) continue
    if (lower.endsWith(`@${dLower}`)) return true
  }
  return false
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `yarn test convex/utils/domainGate.test.ts`
Expected: all tests pass — original 2-arg cases still work because `emails` defaults to `[]`.

- [ ] **Step 5: Commit**

```bash
git add convex/utils/domainGate.ts convex/utils/domainGate.test.ts
git commit -m "feat(convex): extend isAllowedEmail with explicit-email allowlist parameter"
```

---

## Task 4: Add `allowedEmails` table schema

**Files:**

- Create: `convex/allowedEmails/schema.ts`
- Modify: `convex/schema.ts`

- [ ] **Step 1: Write the table definition**

Create `convex/allowedEmails/schema.ts`:

```ts
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * Per-email allowlist. Stored emails are normalized: lowercased + trimmed.
 * Index `byEmail` lets the gate de-dup at insert time and look up
 * existence by exact match.
 *
 * Companion to `allowedEmailDomains`. The gate accepts an email when
 * either (a) its domain matches a domain row OR (b) the lowercased email
 * matches an email row.
 */
export const allowedEmailsSchema = defineTable({
  email: v.string(),
  addedAtMs: v.number(),
  addedByUserId: v.optional(v.id('users')),
}).index('byEmail', ['email'])
```

- [ ] **Step 2: Register in `convex/schema.ts`**

```ts
import { defineSchema } from 'convex/server'

import { allowedEmailDomainsSchema } from './allowedDomains/schema'
import { allowedEmailsSchema } from './allowedEmails/schema'
import { keyRotationJobsSchema } from './keyRotationJobs/schema'
import { machineActivitySchema } from './machineActivity/schema'
import { rateLimitSchema } from './rateLimit/schema'
import { refreshLogSchema } from './refreshLog/schema'
import { subscriptionsSchema } from './subscriptions/schema'
import { usersSchema } from './users/schema'

export default defineSchema({
  allowedEmailDomains: allowedEmailDomainsSchema,
  allowedEmails: allowedEmailsSchema,
  keyRotationJobs: keyRotationJobsSchema,
  machineActivity: machineActivitySchema,
  rateLimit: rateLimitSchema,
  refreshLog: refreshLogSchema,
  subscriptions: subscriptionsSchema,
  users: usersSchema,
})
```

- [ ] **Step 3: Verify type generation succeeds**

Run: `npx convex codegen --once` (or just kick off `yarn test` — the schema is loaded via the test harness)
Expected: no schema-validation errors. `convex/_generated/dataModel.d.ts` now includes `allowedEmails` in the data model.

- [ ] **Step 4: Commit**

```bash
git add convex/allowedEmails/schema.ts convex/schema.ts convex/_generated/dataModel.d.ts convex/_generated/api.d.ts convex/_generated/api.js convex/_generated/server.d.ts convex/_generated/server.js
git commit -m "feat(convex): add allowedEmails table schema"
```

If codegen does not produce changes to the `_generated` files in this step, the dev server / next test run will produce them.

---

## Task 5: `allowedEmails.queries` — `list` + `loadInternal`

**Files:**

- Create: `convex/allowedEmails/queries.ts`
- Create: `convex/allowedEmails/queries.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `convex/allowedEmails/queries.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { BOOTSTRAP_ALLOWED_EMAILS } from '../utils/domainGate'

describe('allowedEmails.queries', () => {
  describe('list (public)', () => {
    it('returns empty array when table empty', async () => {
      const t = vault()
      const rows = await t.query(api.allowedEmails.queries.list, {})
      expect(rows).toEqual([])
    })

    it('returns rows in email-asc order', async () => {
      const t = vault()
      await t.run(async (ctx) => {
        await ctx.db.insert('allowedEmails', { email: 'zeta@example.com', addedAtMs: 100 })
        await ctx.db.insert('allowedEmails', { email: 'alice@example.com', addedAtMs: 200 })
      })
      const rows = await t.query(api.allowedEmails.queries.list, {})
      expect(rows.map((r) => r.email)).toEqual(['alice@example.com', 'zeta@example.com'])
    })

    it('does not require auth', async () => {
      const t = vault()
      const rows = await t.query(api.allowedEmails.queries.list, {})
      expect(Array.isArray(rows)).toBe(true)
    })
  })

  describe('loadInternal', () => {
    it('returns BOOTSTRAP when table empty', async () => {
      const t = vault()
      const rows = await t.query(internal.allowedEmails.queries.loadInternal, {})
      expect(rows).toEqual([...BOOTSTRAP_ALLOWED_EMAILS])
    })

    it('returns lowercased emails when non-empty', async () => {
      const t = vault()
      await t.run(async (ctx) => {
        await ctx.db.insert('allowedEmails', { email: 'Samuel.Asseg@Gmail.Com', addedAtMs: 1 })
      })
      const rows = await t.query(internal.allowedEmails.queries.loadInternal, {})
      expect(rows).toEqual(['samuel.asseg@gmail.com'])
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test convex/allowedEmails/queries.test.ts`
Expected: test setup fails because `convex/allowedEmails/queries` does not exist yet.

- [ ] **Step 3: Implement `convex/allowedEmails/queries.ts`**

```ts
import { v } from 'convex/values'

import { internalQuery, query } from '../_generated/server'
import { BOOTSTRAP_ALLOWED_EMAILS } from '../utils/domainGate'

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id('allowedEmails'),
      email: v.string(),
      addedAtMs: v.number(),
    })
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query('allowedEmails').collect()
    return rows
      .map((r) => ({ _id: r._id, email: r.email, addedAtMs: r.addedAtMs }))
      .sort((a, b) => a.email.localeCompare(b.email))
  },
})

export const loadInternal = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const rows = await ctx.db.query('allowedEmails').collect()
    if (rows.length === 0) return [...BOOTSTRAP_ALLOWED_EMAILS]
    return rows.map((r) => r.email.toLowerCase())
  },
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test convex/allowedEmails/queries.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add convex/allowedEmails/queries.ts convex/allowedEmails/queries.test.ts
git commit -m "feat(convex): allowedEmails.queries.list + loadInternal"
```

---

## Task 6: `allowedEmails.mutations` — `add` + `remove`

**Files:**

- Create: `convex/allowedEmails/mutations.ts`
- Create: `convex/allowedEmails/mutations.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `convex/allowedEmails/mutations.test.ts`:

```ts
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
      // Seed an explicit-email row for alice's own address.
      const aliceRowId = await t.run(
        async (ctx) => await ctx.db.insert('allowedEmails', { email: 'alice@flatout.solutions', addedAtMs: 1 })
      )
      await expect(
        t.withIdentity(TEST_IDENTITY).mutation(api.allowedEmails.mutations.remove, { id: aliceRowId })
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test convex/allowedEmails/mutations.test.ts`
Expected: tests cannot find the mutations module.

- [ ] **Step 3: Implement `convex/allowedEmails/mutations.ts`**

```ts
import { ConvexError, v } from 'convex/values'

import { authenticatedMutation, getIdentity } from '../utils/auth'
import { isValidEmail, normalizeEmail } from '../utils/domainGate'

export const add = authenticatedMutation({
  args: { email: v.string() },
  returns: v.id('allowedEmails'),
  handler: async (ctx, { email }) => {
    const normalized = normalizeEmail(email)
    if (!isValidEmail(normalized)) {
      throw new ConvexError({
        code: 'EMAIL_INVALID',
        message: `'${email}' is not a valid email address.`,
      })
    }
    const existing = await ctx.db
      .query('allowedEmails')
      .withIndex('byEmail', (q) => q.eq('email', normalized))
      .unique()
    if (existing) return existing._id

    const identity = getIdentity(ctx)
    const userRow = await ctx.db
      .query('users')
      .withIndex('byExternalId', (q) => q.eq('externalId', identity.subject))
      .unique()

    return await ctx.db.insert('allowedEmails', {
      email: normalized,
      addedAtMs: Date.now(),
      addedByUserId: userRow?._id,
    })
  },
})

export const remove = authenticatedMutation({
  args: { id: v.id('allowedEmails') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get('allowedEmails', id)
    if (!row) return null

    const identity = getIdentity(ctx)
    const callerEmail = typeof identity.email === 'string' ? identity.email.toLowerCase() : ''
    if (callerEmail.length > 0 && row.email.toLowerCase() === callerEmail) {
      throw new ConvexError({
        code: 'CANNOT_REMOVE_OWN_EMAIL',
        message: 'You cannot remove the explicit-email entry that matches your own email.',
      })
    }

    await ctx.db.delete('allowedEmails', id)
    return null
  },
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test convex/allowedEmails/mutations.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add convex/allowedEmails/mutations.ts convex/allowedEmails/mutations.test.ts
git commit -m "feat(convex): allowedEmails.mutations.add + remove with self-removal guard"
```

---

## Task 7: Wire `loadAllowedEmails` into server + action helpers

**Files:**

- Modify: `convex/utils/domainGateServer.ts`
- Modify: `convex/utils/domainGateAction.ts`

- [ ] **Step 1: Add `loadAllowedEmails` to `domainGateServer.ts`**

Append to `convex/utils/domainGateServer.ts`:

```ts
import { BOOTSTRAP_ALLOWED_EMAILS } from './domainGate'

// (combine with existing BOOTSTRAP_ALLOWED_DOMAINS import in one statement;
// shown here for clarity)

export async function loadAllowedEmails(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
): Promise<string[]> {
  const rows = await ctx.db.query('allowedEmails').collect()
  if (rows.length === 0) return [...BOOTSTRAP_ALLOWED_EMAILS]
  return rows.map((r) => r.email.toLowerCase())
}
```

- [ ] **Step 2: Add `loadAllowedEmailsFromAction` to `domainGateAction.ts`**

Append to `convex/utils/domainGateAction.ts`:

```ts
export async function loadAllowedEmailsFromAction(ctx: GenericActionCtx<DataModel>): Promise<string[]> {
  return await ctx.runQuery(internal.allowedEmails.queries.loadInternal, {})
}
```

- [ ] **Step 3: Verify build**

Run: `yarn lint:check && yarn test convex/utils convex/allowedEmails`
Expected: no type errors; no failing tests.

- [ ] **Step 4: Commit**

```bash
git add convex/utils/domainGateServer.ts convex/utils/domainGateAction.ts
git commit -m "feat(convex): loadAllowedEmails helpers for server+action ctx"
```

---

## Task 8: Update `auth.ts` wrappers to load+pass emails

**Files:**

- Modify: `convex/utils/auth.ts`
- Modify: `convex/utils/auth.test.ts`

- [ ] **Step 1: Add a failing test that the explicit-email path is taken**

In `convex/utils/auth.test.ts`, append a new `describe` block (or add cases inside an existing one — match the existing structure). The test must seed `allowedEmails` row for `samuel.asseg@gmail.com`, sign in as that identity, and assert the wrapped query/mutation/action runs to completion (not rejected with `EMAIL_DOMAIN_NOT_ALLOWED`). The exact code follows the existing test file's harness pattern — read `convex/utils/auth.test.ts` first and follow it.

Sketch (concrete code below in Step 3 once we have the existing file's helpers in context):

```ts
it('accepts identity matched only by allowedEmails (not allowedEmailDomains)', async () => {
  const t = vault()
  await t.run(async (ctx) => {
    await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
    // No allowedEmailDomains row → bootstrap fallback active for domains;
    // bootstrap is ['flatout.solutions'] so gmail.com is NOT covered.
  })
  const samuelIdentity = {
    subject: 'user_samuel',
    issuer: 'https://clear-redbird-6.clerk.accounts.dev',
    tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_samuel',
    name: 'Samuel',
    email: 'samuel.asseg@gmail.com',
  } as const
  // Use any existing simple authenticatedQuery the test file already
  // exercises — match its harness conventions. The point: it should NOT
  // throw EMAIL_DOMAIN_NOT_ALLOWED.
  await expect(t.withIdentity(samuelIdentity).query(api.subscriptions.queries.listForUser, {})).resolves.toBeDefined()
})
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `yarn test convex/utils/auth.test.ts`
Expected: failure on the new test — current `resolveServer` does not load emails, so Samuel is rejected by the domain-only check.

- [ ] **Step 3: Update `resolveServer` and `resolveAction`**

In `convex/utils/auth.ts`, modify both functions to load + pass emails:

```ts
import { loadAllowedDomainsFromAction, loadAllowedEmailsFromAction } from './domainGateAction'
import { loadAllowedDomains, loadAllowedEmails } from './domainGateServer'

async function resolveServer(ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw notAuthenticatedError()
  const [domains, emails] = await Promise.all([loadAllowedDomains(ctx), loadAllowedEmails(ctx)])
  if (!isAllowedEmail(typeof identity.email === 'string' ? identity.email : null, domains, emails)) {
    rejectDomain()
  }
  return identity
}

async function resolveAction(ctx: GenericActionCtx<DataModel>): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw notAuthenticatedError()
  const [domains, emails] = await Promise.all([loadAllowedDomainsFromAction(ctx), loadAllowedEmailsFromAction(ctx)])
  if (!isAllowedEmail(typeof identity.email === 'string' ? identity.email : null, domains, emails)) {
    rejectDomain()
  }
  return identity
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `yarn test convex/utils/auth.test.ts`
Expected: all tests pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add convex/utils/auth.ts convex/utils/auth.test.ts
git commit -m "feat(convex): auth wrappers consult per-email allowlist alongside domains"
```

---

## Task 9: Update `mintAction` to load+pass emails

**Files:**

- Modify: `convex/cli/mintAction.ts`
- Modify: `convex/cli/mintAction.test.ts`

- [ ] **Step 1: Add a failing test that explicit-email mints succeed**

In `convex/cli/mintAction.test.ts`, append a test that:

1. seeds `allowedEmails` row for `samuel.asseg@gmail.com`
2. mocks `verifyToken` to return `{ sid, sub, email: 'samuel.asseg@gmail.com' }`
3. asserts mint succeeds.

Match the existing file's harness. Sketch:

```ts
it('mints when identity is matched only via allowedEmails (not via domain)', async () => {
  const t = vault()
  await t.run(async (ctx) => {
    await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
  })
  mockVerify({ sid: 'sess_x', sub: 'user_samuel', email: 'samuel.asseg@gmail.com' })
  __setClerkFetch(
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ jwt: 'jwt-ok' }), { status: 200 }))
    ) as unknown as typeof fetch
  )
  const result = await t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'tok' })
  expect(result.jwt).toBe('jwt-ok')
})
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `yarn test convex/cli/mintAction.test.ts`
Expected: failure — current mint only checks domains.

- [ ] **Step 3: Update `mintAction.ts` to load + pass emails**

```ts
import { loadAllowedDomainsFromAction, loadAllowedEmailsFromAction } from '../utils/domainGateAction'

// ...inside handler...
const [domains, emails] = await Promise.all([loadAllowedDomainsFromAction(ctx), loadAllowedEmailsFromAction(ctx)])
if (!isAllowedEmail(email, domains, emails)) {
  throw new ConvexError({
    code: DOMAIN_REJECTION_ERROR_CODE,
    message: DOMAIN_REJECTION_MESSAGE,
  })
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `yarn test convex/cli/mintAction.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add convex/cli/mintAction.ts convex/cli/mintAction.test.ts
git commit -m "feat(convex): mintAction consults per-email allowlist"
```

---

## Task 10: Update Clerk webhook to load+pass emails

**Files:**

- Modify: `convex/webhooks/clerk.ts`
- Modify: `convex/webhooks/clerk.test.ts`

- [ ] **Step 1: Add a failing test for webhook explicit-email accept**

In `convex/webhooks/clerk.test.ts`, append:

```ts
it('upserts the user when primary email is on the explicit emails allowlist (not the domain list)', async () => {
  const t = vault()
  // Seed: gmail.com is NOT a domain on the allowlist; samuel.asseg@gmail.com IS on the email allowlist.
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
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `yarn test convex/webhooks/clerk.test.ts`
Expected: webhook deletes Samuel's user via BAPI because the current code only checks domains.

- [ ] **Step 3: Update `webhooks/clerk.ts` to load+pass emails**

```ts
const [domains, emails] = await Promise.all([
  ctx.runQuery(internal.allowedDomains.queries.loadInternal, {}),
  ctx.runQuery(internal.allowedEmails.queries.loadInternal, {}),
])
if (!isAllowedEmail(email, domains, emails)) {
  // existing rejection path unchanged
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `yarn test convex/webhooks/clerk.test.ts`
Expected: all tests pass — explicit-email user is accepted; domain-only and bootstrap users still work.

- [ ] **Step 5: Commit**

```bash
git add convex/webhooks/clerk.ts convex/webhooks/clerk.test.ts
git commit -m "feat(convex): webhook consults per-email allowlist before BAPI deletion"
```

---

## Task 11: Update DomainGuard to load+pass emails

**Files:**

- Modify: `frontend/src/components/auth/DomainGuard.tsx`

- [ ] **Step 1: Update the component**

```tsx
const allowedDomainRows = useQuery(api.allowedDomains.queries.list, {})
const allowedEmailRows = useQuery(api.allowedEmails.queries.list, {})

if (!isLoaded || allowedDomainRows === undefined || allowedEmailRows === undefined) return null

const domains =
  allowedDomainRows.length > 0 ? allowedDomainRows.map((r) => r.domain.toLowerCase()) : [...BOOTSTRAP_ALLOWED_DOMAINS]
const emails =
  allowedEmailRows.length > 0 ? allowedEmailRows.map((r) => r.email.toLowerCase()) : [...BOOTSTRAP_ALLOWED_EMAILS]

if (!isSignedIn) return <>{children}</>

const email = user.primaryEmailAddress?.emailAddress ?? null
if (isAllowedEmail(email, domains, emails)) return <>{children}</>

return <DomainBlocked onSignOut={() => void signOut()} email={email} domains={domains} emails={emails} />
```

Update `DomainBlocked` to accept and render the explicit-email list when non-empty:

```tsx
function DomainBlocked({
  onSignOut,
  email,
  domains,
  emails,
}: {
  onSignOut: () => void
  email: string | null
  domains: string[]
  emails: string[]
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
          {emails.length > 0 ? (
            <>
              {' '}
              · Explicit allowed emails:{' '}
              {emails.map((e) => (
                <code key={e} className="bg-muted mx-0.5 rounded px-1 py-0.5 text-xs">
                  {e}
                </code>
              ))}
            </>
          ) : null}
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

Update the import line:

```tsx
import {
  BOOTSTRAP_ALLOWED_DOMAINS,
  BOOTSTRAP_ALLOWED_EMAILS,
  isAllowedEmail,
} from '../../../../convex/utils/domainGate'
```

- [ ] **Step 2: Verify lint+build**

Run: `yarn lint:check && yarn test`
Expected: no errors. Existing DomainGuard tests still pass; if a new test is needed for explicit-email behavior, add it (current repo has no DomainGuard test file — call out the gap in the PR).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/auth/DomainGuard.tsx
git commit -m "feat(frontend): DomainGuard consults per-email allowlist"
```

---

## Task 12: New `/dashboard/settings/emails` page (static + lazy)

**Files:**

- Create: `frontend/src/routes/dashboard/settings/emails.tsx`
- Create: `frontend/src/routes/dashboard/settings/emails.lazy.tsx`

- [ ] **Step 1: Write the static stub `emails.tsx`**

```tsx
/**
 * /dashboard/settings/emails — static route declaration.
 *
 * Pairs with `emails.lazy.tsx` (page component). Mirrors the
 * `domains.tsx` + `domains.lazy.tsx` convention used everywhere else.
 */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/dashboard/settings/emails')({})
```

- [ ] **Step 2: Write the page component `emails.lazy.tsx`**

```tsx
import { useUser } from '@clerk/tanstack-react-start'
import { zodResolver } from '@hookform/resolvers/zod'
import { createLazyFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

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

const emailSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email required')
    .max(320, 'Email too long')
    .email('Invalid email format')
    .transform((s) => s.toLowerCase()),
})

type EmailFormValues = z.infer<typeof emailSchema>

export const Route = createLazyFileRoute('/dashboard/settings/emails')({
  component: EmailsPage,
})

export function EmailsPage() {
  const { user } = useUser()
  const callerEmail = (user?.primaryEmailAddress?.emailAddress ?? '').toLowerCase()

  const rows = useQuery(api.allowedEmails.queries.list, {})
  const add = useMutation(api.allowedEmails.mutations.add)
  const remove = useMutation(api.allowedEmails.mutations.remove)

  const [error, setError] = useState<string | null>(null)
  const [pendingRemoveId, setPendingRemoveId] = useState<Id<'allowedEmails'> | null>(null)
  const [pendingRemoveEmail, setPendingRemoveEmail] = useState<string>('')

  const addForm = useForm<EmailFormValues>({
    resolver: zodResolver(emailSchema),
    mode: 'onChange',
    defaultValues: { email: '' },
  })
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = addForm

  const onAdd = handleSubmit(async (values) => {
    setError(null)
    try {
      await add({ email: values.email })
      reset({ email: '' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  })

  async function onConfirmRemove() {
    if (!pendingRemoveId) return
    setError(null)
    try {
      await remove({ id: pendingRemoveId })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingRemoveId(null)
      setPendingRemoveEmail('')
    }
  }

  if (rows === undefined) {
    return <div className="text-muted-foreground p-6 text-sm">Loading…</div>
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Allowed emails</h1>
        <p className="text-muted-foreground text-sm">
          Specific email addresses permitted to sign in to cvault, in addition to the allowed domains. Use this for
          one-off exceptions where opening up a whole domain is too broad.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="border-border bg-card rounded-lg border p-4 text-sm">
          No explicit emails configured. The allowed-domains list is the only gate. Add an email to grant access without
          opening up its entire domain.
        </div>
      ) : (
        <ul className="border-border bg-card divide-border divide-y rounded-lg border">
          {rows.map((r) => {
            const isOwn = callerEmail.length > 0 && r.email.toLowerCase() === callerEmail
            return (
              <li key={r._id} className="flex items-center justify-between p-3">
                <span className="font-mono text-sm">{r.email}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(isOwn)}
                  onClick={() => {
                    setPendingRemoveId(r._id)
                    setPendingRemoveEmail(r.email)
                  }}
                  aria-label={`Remove ${r.email}`}
                  title={isOwn ? 'You cannot remove your own email' : undefined}
                >
                  Remove
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          void onAdd(e)
        }}
        className="flex flex-col gap-2"
        noValidate
      >
        <Label htmlFor="add-email">Add email</Label>
        <div className="flex items-center gap-2">
          <Input id="add-email" placeholder="someone@example.com" className="max-w-xs" {...register('email')} />
          <Button type="submit" size="sm">
            Add
          </Button>
        </div>
        {errors.email ? (
          <p className="text-destructive text-xs" role="alert">
            {errors.email.message}
          </p>
        ) : null}
      </form>

      {error !== null && (
        <div className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm" role="alert">
          {error}
        </div>
      )}

      <Dialog
        open={pendingRemoveId !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPendingRemoveId(null)
            setPendingRemoveEmail('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove explicit email?</DialogTitle>
            <DialogDescription>
              Removing <code className="bg-muted rounded px-1">{pendingRemoveEmail}</code> revokes access on the user's
              next sign-in (unless their domain is on the allowed-domains list).
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

- [ ] **Step 3: Regenerate route tree**

Run: `cd frontend && yarn tsr generate` (or rely on the dev server)
Expected: `routeTree.gen.ts` now imports both `emails.tsx` and `emails.lazy.tsx`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/routes/dashboard/settings/emails.tsx frontend/src/routes/dashboard/settings/emails.lazy.tsx frontend/src/routeTree.gen.ts
git commit -m "feat(frontend): /dashboard/settings/emails CRUD page"
```

---

## Task 13: Add "Allowed emails" card to the settings index

**Files:**

- Modify: `frontend/src/routes/dashboard/settings.lazy.tsx`

- [ ] **Step 1: Add a new Card next to "Allowed email domains"**

Insert after the existing "Allowed email domains" card, before the closing `</div>` of the grid:

```tsx
<Card>
  <CardHeader>
    <CardTitle>Allowed emails</CardTitle>
    <CardDescription>
      Allow specific email addresses without opening up their domain. Useful for one-off exceptions like contractors or
      personal addresses.
    </CardDescription>
  </CardHeader>
  <CardContent>
    <Link to="/dashboard/settings/emails" className="text-primary text-sm hover:underline">
      Manage allowed emails →
    </Link>
  </CardContent>
</Card>
```

- [ ] **Step 2: Verify lint+build**

Run: `yarn lint:check && yarn build`
Expected: build succeeds; route /dashboard/settings/emails reachable.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/routes/dashboard/settings.lazy.tsx
git commit -m "feat(frontend): link to per-email allowlist from settings index"
```

---

## Task 14: End-to-end scenario test for the per-email allowlist

**Files:**

- Create: `convex/__scenarios__/perEmailAllowlist.scenario.test.ts`

- [ ] **Step 1: Write the scenario**

```ts
/**
 * Scenario — per-email allowlist end-to-end.
 *
 * Companion to flatoutDomainOnly.scenario.test.ts. Exercises:
 *  1. Explicit-email user passes signup webhook even when their domain is
 *     not on the domain allowlist; subsequent authed query succeeds; mint
 *     succeeds.
 *  2. Non-explicit user with non-allowed domain is rejected (BAPI delete).
 *  3. Removing the explicit-email row immediately blocks the user.
 *  4. Adding the same email twice is idempotent (returns the same row id).
 *
 * Hermetic — no real network, no real Clerk.
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

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = 'sk_test_dummy'
  process.env.CLERK_WEBHOOK_SECRET = 'whsec_dummy'
  verifyTokenMock.mockReset()
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

function mockVerify(payload: object) {
  verifyTokenMock.mockResolvedValue(payload as never)
}

describe('scenario — per-email allowlist', () => {
  it('explicit-email user signs up successfully and can call authed APIs', async () => {
    const t = vault()
    // Seed: gmail.com NOT on the domain allowlist; samuel's email IS on the explicit list.
    await t.run(async (ctx) => {
      await ctx.db.insert('allowedEmailDomains', { domain: 'flatout.solutions', addedAtMs: 1 })
      await ctx.db.insert('allowedEmails', { email: 'samuel.asseg@gmail.com', addedAtMs: 1 })
    })

    // Webhook accepts samuel even though gmail.com is not allowed.
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
    expect(fetchStub).not.toHaveBeenCalled()

    // Authed query as samuel works.
    const samuelIdentity = {
      subject: 'user_samuel',
      issuer: 'https://clear-redbird-6.clerk.accounts.dev',
      tokenIdentifier: 'https://clear-redbird-6.clerk.accounts.dev|user_samuel',
      name: 'Samuel',
      email: 'samuel.asseg@gmail.com',
    } as const
    const subs = await t.withIdentity(samuelIdentity).query(api.subscriptions.queries.listForUser, {})
    expect(Array.isArray(subs)).toBe(true)

    // CLI mint succeeds.
    mockVerify({ sid: 'sess_samuel', sub: 'user_samuel', email: 'samuel.asseg@gmail.com' })
    __setClerkFetch(
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ jwt: 'jwt-ok' }), { status: 200 }))
      ) as unknown as typeof fetch
    )
    const m = await t.action(internal.cli.mintAction.mintConvexJwt, { clerkSessionToken: 'tok' })
    expect(m.jwt).toBe('jwt-ok')
  })

  it('non-explicit, non-domain user is rejected (webhook deletes via BAPI; query rejects)', async () => {
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

    await t.withIdentity(TEST_IDENTITY).mutation(api.allowedEmails.mutations.remove, { id: samuelEmailRowId })

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
```

- [ ] **Step 2: Run scenario tests**

Run: `yarn test:scenario convex/__scenarios__/perEmailAllowlist.scenario.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add convex/__scenarios__/perEmailAllowlist.scenario.test.ts
git commit -m "test(convex): scenario coverage for per-email allowlist end-to-end"
```

---

## Task 15: Domain UI scenario regression coverage

**Files:**

- Modify: `convex/__scenarios__/flatoutDomainOnly.scenario.test.ts` (or add a small companion scenario)

The user reported "domain UI not working" and we fixed the missing static stub in Task 1. The frontend route registration is not directly covered by Convex scenarios, but the backend mutation/query round-trip drove by the UI is — and that round-trip already has coverage in `flatoutDomainOnly.scenario.test.ts`'s "dynamic round-trip" case. Verify we're not missing a CRUD-via-mutation regression test for this area; if not, add one. Otherwise mark this task complete.

- [ ] **Step 1: Re-read existing scenario**

Run: `yarn test:scenario convex/__scenarios__/flatoutDomainOnly.scenario.test.ts`
Expected: passes today, including "dynamic round-trip: add acme.com → bob signs in; remove → bob blocked" — this exercises the same `api.allowedDomains.mutations.add`/`remove` path the UI uses.

- [ ] **Step 2: If existing coverage is sufficient (it is for the data layer), no new scenario needed.**

The frontend bug is route-registration only (caught by build + manual smoke test, not by Convex scenarios). The static stub is exercised by yarn build prerender pass.

- [ ] **Step 3: Run yarn build to confirm prerender succeeds**

Run: `yarn build`
Expected: build succeeds; `dist/client/dashboard/settings/domains/index.html` exists if prerender resolves (or at least the route is registered without warnings).

No commit if no code change.

---

## Task 16: Full test + lint + build sweep

- [ ] **Step 1: Run full unit test suite**

Run: `yarn test`
Expected: all tests pass.

- [ ] **Step 2: Run full scenario suite**

Run: `yarn test:scenario`
Expected: all scenarios pass (including the existing flatoutDomainOnly + new perEmailAllowlist).

- [ ] **Step 3: Lint**

Run: `yarn lint:check`
Expected: clean.

- [ ] **Step 4: Format**

Run: `yarn format:check`
Expected: clean (run `yarn format:fix` if not).

- [ ] **Step 5: Build**

Run: `yarn build`
Expected: success.

- [ ] **Step 6: Final commit if any auto-format or codegen changes landed**

```bash
git add -A
git status  # review
# only commit if a meaningful auto-format / codegen change is staged
git commit -m "chore: post-feature lint/format sync"
```

---

## Task 17: Push branch + create PR

- [ ] **Step 1: Push the branch with explicit upstream tracking (NOT origin/main)**

```bash
git push -u origin feat/per-email-allowlist
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --base main --head feat/per-email-allowlist --title "feat: per-email allowlist + fix /dashboard/settings/domains route stub" --body "$(cat <<'EOF'
## Summary

- Add a per-email allowlist (`allowedEmails` table + CRUD + UI page) that runs in parallel with the existing domain allowlist. An email passes the gate if either the domain matches OR the explicit email matches.
- Fix the `/dashboard/settings/domains` route by adding the missing static stub (`domains.tsx`) — every other dashboard route follows the `<x>.tsx` + `<x>.lazy.tsx` convention; this one was incomplete and TanStack Router's synthetic codegen was an unreliable fallback.
- Wire the new email list through the webhook, auth wrappers, mintAction, and DomainGuard.

## Why

User wanted to allow `samuel.asseg@gmail.com` to sign up. Adding `gmail.com` is too broad. Per-email exceptions with a separate UI keep the audit trail clean.

## Test plan

- [ ] yarn test (unit): passes
- [ ] yarn test:scenario (per-email + flatout-domain): passes
- [ ] yarn lint:check: clean
- [ ] yarn build: succeeds; `/dashboard/settings/domains` and `/dashboard/settings/emails` both registered
- [ ] Smoke test (post-merge): admin signs in, navigates to `/dashboard/settings/emails`, adds `samuel.asseg@gmail.com`, signs out, then `samuel.asseg@gmail.com` can sign up via Clerk and land in the dashboard

## Adding the user's address post-merge

Two options once merged + deployed:

1. **Recommended**: admin signs in, opens `/dashboard/settings/emails`, types `samuel.asseg@gmail.com`, hits Add.
2. CLI alternative: `npx convex run allowedEmails:mutations:add '{"email":"samuel.asseg@gmail.com"}'` from a workstation with admin Clerk session active.

Per the brief, this PR does NOT seed the address into the bootstrap or insert it via migration — that's the user's call.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Capture and report the PR URL.**

---

## Self-Review

### Spec coverage

| Brief item                                                                              | Task         |
| --------------------------------------------------------------------------------------- | ------------ |
| New `allowedEmails` table + index + normalized email                                    | Task 4       |
| Helpers `BOOTSTRAP_ALLOWED_EMAILS`, `normalizeEmail`, `isValidEmail`                    | Task 2       |
| `isAllowedEmail` extended with `emails` (default `[]`)                                  | Task 3       |
| `allowedEmails.mutations.add` / `remove` (auth, dedupe, invalid, cannot-remove-own)     | Task 6       |
| `allowedEmails.queries.list` / `loadInternal` (sorted, bootstrap)                       | Task 5       |
| Wire into `convex/schema.ts`                                                            | Task 4       |
| Webhook loads + passes both lists                                                       | Task 10      |
| DomainGuard loads + passes both lists                                                   | Task 11      |
| New `/dashboard/settings/emails` page (Zod email validation, list, add, remove confirm) | Task 12      |
| Static stub for `domains.tsx` (the bug)                                                 | Task 1       |
| Settings index links both                                                               | Task 13      |
| Domain UI fix: routeTree regen                                                          | Task 1, 12   |
| Unit tests for new domainGate helpers                                                   | Tasks 2, 3   |
| Convex tests for `allowedEmails` mutations + queries                                    | Tasks 5, 6   |
| Webhook test: explicit-email accept                                                     | Task 10      |
| Scenario tests: per-email allowlist e2e + non-matching reject + bootstrap               | Task 14      |
| Domain CRUD + UI scenario coverage (re-verify existing, add if needed)                  | Task 15      |
| `samuel.asseg@gmail.com` not seeded — admin uses UI/CLI per brief                       | Task 17 body |
| Branch with own tracking, conventional commits, no `--no-verify`, no push to main       | Task 17, all |

### Placeholder scan

No "TBD" / "implement later" / "similar to X". Each task has full code blocks for code steps; full bash for command steps. Test code is explicit. The auth.test.ts step has a sketch with the explicit instruction to match the existing harness — acceptable because the existing test file is the single source of truth for harness conventions and the engineer must read it to fit in cleanly. Mint test similarly. (Not a placeholder for the change itself; the change snippet is fully specified.)

### Type consistency

- Symbols used everywhere: `BOOTSTRAP_ALLOWED_EMAILS`, `normalizeEmail`, `isValidEmail`, `isAllowedEmail(email, domains, emails?)`.
- Mutation names: `api.allowedEmails.mutations.add`, `api.allowedEmails.mutations.remove`.
- Query names: `api.allowedEmails.queries.list`, `internal.allowedEmails.queries.loadInternal`.
- Error codes: `EMAIL_INVALID` (validator), `CANNOT_REMOVE_OWN_EMAIL` (self-removal), `EMAIL_DOMAIN_NOT_ALLOWED` (gate rejection — reused, not duplicated).
- Loaders: `loadAllowedEmails(ctx)`, `loadAllowedEmailsFromAction(ctx)`.

All references match across tasks.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-07-per-email-allowlist.md`. The brief instructs me to execute end-to-end without coming back; I will execute inline using `superpowers:executing-plans` semantics, with a single verification pass per task and a final test/lint/build sweep before pushing.
