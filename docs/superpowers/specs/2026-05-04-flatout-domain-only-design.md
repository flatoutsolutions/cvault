# Restrict cvault to allowlisted email domains (default: `@flatout.solutions`)

**Status:** approved (revised 2026-05-04 mid-flight per user direction)
**Date:** 2026-05-04
**Author:** domain-gate (cccollab session)
**Branch:** `feat/flatout-domain-only`
**Related:** docs/superpowers/specs/2026-05-02-cvault-design.md (cvault canonical design)

## 1. Goal

cvault is an internal FlatOut Solutions tool. Account creation and platform access must be restricted to people whose primary email is on the allowlist. The allowlist defaults to `flatout.solutions` and is **configurable via the dashboard UI** by any signed-in user. Anyone else who somehow lands in Clerk (typosquat, social-login leak, manual invite mistake) must be rejected at every server boundary so they cannot read or write any data.

The user explicitly directed this implementation to **not** sit behind a feature flag — the restriction is permanent. The allowlist is a runtime configuration, not a build-time constant.

## 2. Non-goals

- Per-organization Clerk Organizations / multi-tenant access. cvault is single-tenant. Out of scope.
- Email verification flow changes. Clerk already requires verified emails before `user.created` fires.
- Admin role / RBAC. Any signed-in user can manage the allowlist. (If a future need arises, gate the `add`/`remove` mutations on a `users.role === 'admin'` field; out of scope here.)
- Migration of pre-existing non-allowlisted users. Manual cleanup via Clerk dashboard if any have signed up.
- Per-user / individual-email allowlist. Domain-level only.

## 3. Architecture

### 3.1 Defense-in-depth layers

A signed-in user travels through five layers to reach data. Each layer is independent — even if one is misconfigured, the next blocks. This matters because Clerk's dashboard-side allowed-domains list is a _configuration_ (Stefan can disable it), not a guarantee.

| #   | Layer                          | Where                                          | What it does                                                                                                                                       |
| --- | ------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Clerk dashboard                | `clerk.com` settings                           | Allowed email domains = `flatout.solutions`. Blocks signup at the source. **Manual / out-of-code.**                                                |
| 2   | Convex webhook                 | `convex/webhooks/clerk.ts`                     | On `user.created`/`user.updated`, if primary email is wrong-domain → call Clerk BAPI `DELETE /v1/users/{id}` to nuke the user, log it, return 200. |
| 3   | Authenticated Convex functions | `convex/utils/auth.ts`                         | Every authed query/mutation/action checks the JWT identity's email — throws `EMAIL_DOMAIN_NOT_ALLOWED` ConvexError if mismatch.                    |
| 4   | CLI JWT mint                   | `convex/cli/mintAction.ts`                     | The `verifyToken` payload's `email` is checked. Wrong domain → mint refused → CLI cannot get a Convex JWT.                                         |
| 5   | Frontend guard                 | `frontend/src/components/auth/DomainGuard.tsx` | Reads Clerk's `useUser()`, signs out wrong-domain users client-side, shows a friendly error page. UX only — backend already enforces.              |

Layer 1 is documented but not coded; layers 2-5 are this PR.

### 3.2 Single source of truth

The allowlist is **stored in Convex** in a dedicated `allowedEmailDomains` table. All five layers consult that table at request time. A pure helper module exposes the matching algorithm.

```
convex/utils/domainGate.ts                       — pure (framework-free)
─ BOOTSTRAP_ALLOWED_DOMAINS: ReadonlyArray<string> = ['flatout.solutions']
─ isAllowedEmail(email: string | null | undefined, domains: ReadonlyArray<string>): boolean
─ normalizeDomain(input: string): string  // lowercase, trim, strip leading '@'
─ isValidDomain(input: string): boolean   // RFC-ish format check
─ DOMAIN_REJECTION_ERROR_CODE: 'EMAIL_DOMAIN_NOT_ALLOWED'
─ DOMAIN_REJECTION_MESSAGE: 'Your email domain is not allowed to use cvault.'

convex/utils/domainGateServer.ts                 — Convex query/mutation ctx
─ loadAllowedDomains(ctx: QueryCtx | MutationCtx): Promise<string[]>
    // Reads `allowedEmailDomains` table; if empty falls back to BOOTSTRAP.

convex/utils/domainGateAction.ts                 — Convex action ctx
─ loadAllowedDomainsFromAction(ctx: ActionCtx): Promise<string[]>
    // Calls internal.allowedDomains.queries.loadInternal.
```

The pure module imports nothing — frontend (`../../../../convex/utils/domainGate`) and CLI can import it. The server modules import Convex types and the data-model helper queries.

`isAllowedEmail(email, domains)` checks:

- Lowercase the email.
- Reject if email lacks `@`, contains whitespace, or is `null`/`undefined`/empty.
- For each `domain` in `domains` (already lowercased), accept if `email.endsWith('@' + domain)`.
- The strict `@`-prefix check defeats subdomain-suffix attacks (`evil.flatout.solutions` does NOT end in `@flatout.solutions`).

### 3.2.1 `allowedEmailDomains` schema

```ts
allowedEmailDomains: defineTable({
  domain: v.string(), // normalized: lowercase, no '@'
  addedAtMs: v.number(), // Date.now() at insert
  addedByUserId: v.optional(v.id('users')), // who added (null if seeded by bootstrap)
}).index('byDomain', ['domain'])
```

### 3.2.2 Bootstrap fallback

If the `allowedEmailDomains` table is empty, every server-side helper returns `BOOTSTRAP_ALLOWED_DOMAINS = ['flatout.solutions']`. This guarantees:

- Fresh deployment with no rows yet → still works for FlatOut users.
- A future user accidentally removes every row → fallback prevents lockout.

The bootstrap is **intentional fallback, not migration**. The table starts empty; rows accumulate as users add via the UI.

### 3.2.3 Public API surface

```
api.allowedDomains.queries.list      (PUBLIC, no auth) → list of {_id, domain, addedAtMs}
                                      Used by frontend DomainGuard + settings page.

api.allowedDomains.queries.loadInternal  (internalQuery) → string[] with bootstrap applied
                                      Used by mintAction (action context).

api.allowedDomains.mutations.add     (authenticatedMutation) → Id<'allowedEmailDomains'>
                                      args: { domain: string }
                                      Validates, normalizes, idempotent.

api.allowedDomains.mutations.remove  (authenticatedMutation) → null
                                      args: { id: Id<'allowedEmailDomains'> }
                                      No-op if id not found.
```

`queries.list` is intentionally **public** (no auth). The list of allowed domains is not sensitive — Clerk's signup page already shows it implicitly. Public access lets the frontend `DomainGuard` consult the allowlist before the user is authenticated, avoiding a chicken-and-egg with `authenticatedQuery`.

Mutations are gated by `authenticatedMutation` so only signed-in (allowlisted) users can manage. Idempotent on `add` (returns existing id if domain already present).

### 3.3 Webhook flow (layer 2)

```
Clerk → POST /webhooks/clerk → validateRequest → (if user.created/user.updated)
                                                    │
                                                    ▼
                                  isAllowedEmail(primaryEmail)?
                                    │             │
                                  yes             no
                                    │             │
                                    ▼             ▼
                          users.actions.upsert    cli.clerk.deleteClerkUser(id)
                                                    │
                                                    ▼
                                         (also remove any orphan users row
                                          that may have slipped in before)
                                                    │
                                                    ▼
                                              return 200 + log
```

Why delete via BAPI rather than just ignore the webhook event:

- If we ignore, the user is still signed in on the dashboard URL. They can poke at Clerk-only routes, see their own profile, attempt to call our APIs (we'll reject — but they'll see a hostile error rather than a clean "you cannot use this app").
- BAPI delete revokes all sessions and removes the user. Next page load → signed out, clean state.
- Clerk webhooks are idempotent; if delete fails for any reason (e.g. already deleted), the action returns gracefully and the next webhook retry will be a no-op.

Webhook still returns 200 on rejection — Clerk retries on 4xx/5xx, and we don't want the rejection to keep retrying forever.

### 3.4 Authenticated function flow (layer 3)

`authenticatedQuery`, `authenticatedMutation`, `authenticatedAction` are wrappers around `query`/`mutation`/`action` defined in `convex/utils/auth.ts`. They already check `ctx.auth.getUserIdentity()` is non-null. We extend them to consult the **runtime** allowlist:

```ts
// Query / Mutation:
const identity = await ctx.auth.getUserIdentity()
if (!identity) throw new Error('Not authenticated')
const domains = await loadAllowedDomains(ctx)              // reads allowedEmailDomains table
if (!isAllowedEmail(identity.email, domains)) {
  throw new ConvexError({ code: DOMAIN_REJECTION_ERROR_CODE, message: DOMAIN_REJECTION_MESSAGE })
}
return await fn.handler(Object.assign(ctx, { identity }), args as Args)

// Action (separate helper because actions can't use ctx.db):
const domains = await loadAllowedDomainsFromAction(ctx)    // calls internalQuery
```

`identity.email` comes from the Clerk JWT's `email` claim. The browser/SSR flow uses Clerk's `convex` JWT template (configured to include `email`) and `ctx.auth.getUserIdentity()` reads it. The CLI flow is different — see §3.5 — and resolves email via BAPI. If the claim is missing in the convex-template path the helper returns `false` and the call is rejected — that's the correct safe-default. The convex-template requirement is documented explicitly in `MANUAL_TESTING.md`.

This is the strict-server enforcement layer. Every authenticated function pays the cost of one indexed table read on `allowedEmailDomains` per call — Convex query latency is ~ms in-region, and the table will hold at most a few rows. No caching needed.

### 3.5 CLI mint flow (layer 4)

`convex/cli/mintAction.ts::mintConvexJwt` verifies the supplied Clerk session JWT via `@clerk/backend.verifyToken`, then resolves the caller's email and runs the runtime-allowlist check.

**Important:** the CLI passes Clerk's _default session token_ (the `last_active_token.jwt` returned from `/v1/client/sign_ins`), NOT a custom JWT-template token. Per Clerk's session-token reference, the default session token's claims are only `azp, exp, iat, iss, jti, nbf, sub` — there is **no `email` claim**. (The `email` claim is something the `convex` JWT template adds for browser/SSR clients via `ctx.auth.getUserIdentity()`; it does not apply to the CLI's session-token path.)

So the gate has two paths:

1. If `payload.email` is present (browser/SSR clients calling this action with a template token), trust the JWKS-verified claim.
2. Otherwise (CLI session-token path), call BAPI `users.getUser(payload.sub)` and read `primaryEmailAddress.emailAddress`. `payload.sub` is JWKS-verified, so this is an authenticated lookup of the user the caller already proved they are — not a trust-the-input situation.

```ts
let email: string | null = null
if (typeof payload.email === 'string' && payload.email.length > 0) {
  email = payload.email
} else {
  const clerk = getClerkBackendClient({ secretKey })
  try {
    const user = await clerk.users.getUser(payload.sub)
    email = user.primaryEmailAddress?.emailAddress ?? null
  } catch (err) {
    throw new ConvexError({
      code: 'CLERK_BACKEND_ERROR',
      message: `BAPI getUser failed while resolving session email: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}
const domains = await loadAllowedDomainsFromAction(ctx)
if (!isAllowedEmail(email, domains)) {
  throw new ConvexError({
    code: DOMAIN_REJECTION_ERROR_CODE,
    message: DOMAIN_REJECTION_MESSAGE,
  })
}
```

The `getClerkBackendClient` factory in `convex/cli/clerk.ts` is a separate test seam from `__setClerkFetch`, because `createClerkClient` from `@clerk/backend` uses its own internal request layer that the fetch hook does not reach.

`convex/cli/httpMint.ts::cliMintHandler` maps `EMAIL_DOMAIN_NOT_ALLOWED` → HTTP 403.

`cli/src/auth/clerkFapi.ts::mintConvexJwt`: Recognizes the 403 + code combination and surfaces a `ClerkEmailDomainNotAllowedError` distinct from `ClerkSessionExpiredError`. The CLI's `login.ts` catches it and prints:

```
Error: Only @flatout.solutions accounts may use cvault.
Sign out at <dashboard URL> and try again with your work email.
```

Exit code: 1 (auth failure).

### 3.6 Frontend guard (layer 5)

New component `frontend/src/components/auth/DomainGuard.tsx`:

```tsx
function DomainGuard({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, user } = useUser()
  const { signOut } = useClerk()
  const allowedRows = useQuery(api.allowedDomains.queries.list, {})
  const email = user?.primaryEmailAddress?.emailAddress

  if (!isLoaded || allowedRows === undefined) return null

  // Apply the same bootstrap fallback the server uses, so a brand-new
  // deployment with no rows still works for FlatOut users.
  const domains =
    allowedRows.length > 0 ? allowedRows.map((r) => r.domain.toLowerCase()) : [...BOOTSTRAP_ALLOWED_DOMAINS]

  if (!isSignedIn) return <>{children}</>
  if (isAllowedEmail(email, domains)) return <>{children}</>
  return <DomainBlockedError onSignOut={() => signOut()} email={email ?? null} domains={domains} />
}
```

Wraps `<RootComponent>`'s children inside `ConvexProviderWithClerk` (so `useQuery` works). The `DomainBlockedError` page tells the user which domains are allowed and offers a "Sign out and try again" button. Without this, a signed-in non-allowlisted user would see a broken dashboard (every Convex query throws `EMAIL_DOMAIN_NOT_ALLOWED`) — confusing UX.

The frontend guard is **UX only** — it must not be the only check. Server still enforces. A user disabling JS could bypass the guard; they'd then hit layer 3 errors on every Convex call.

### 3.6.1 Settings UI (`/dashboard/settings/domains`)

New route at `frontend/src/routes/dashboard/settings/domains.lazy.tsx`. (Could also be a tab/section on `/dashboard/settings` — keep simple by giving it its own route.)

The page:

- Lists current allowed domains (from `api.allowedDomains.queries.list`) in a small ShadCN table or list, each with a `Remove` button.
- An input + `Add domain` button. On submit: client-validates with `isValidDomain`, calls `api.allowedDomains.mutations.add`. Shows a Convex error inline if validation fails server-side.
- Empty-state hint: "No domains configured. Bootstrap fallback (`flatout.solutions`) is active. Add a domain to take control of the allowlist."
- Confirmation dialog on `Remove` ("Remove `acme.com` from the allowlist? Users with this email domain will lose access.").
- Add link to `/dashboard/settings/domains` inside the existing `/dashboard/settings` page.

### 3.6.2 Self-removal guard

Critical edge case: the user removes the domain that contains their own email. They'd lock themselves out. The `remove` mutation handler **rejects** an attempted self-removal:

```ts
// convex/allowedDomains/mutations.ts (in `remove`)
const callerEmail = identity.email ?? ''
const callerDomain = callerEmail.split('@')[1]?.toLowerCase()
if (callerDomain && row.domain.toLowerCase() === callerDomain) {
  throw new ConvexError({
    code: 'CANNOT_REMOVE_OWN_DOMAIN',
    message: 'You cannot remove the domain that your own email belongs to.',
  })
}
```

Frontend disables the `Remove` button for the matching row + shows a tooltip explaining why.

### 3.7 BAPI deleteClerkUser helper

New export in `convex/cli/clerk.ts` (already houses BAPI helpers):

```ts
export async function deleteClerkUser(
  userId: string
): Promise<{ ok: true } | { ok: false; status: number; body: string }>
```

Calls `DELETE https://api.clerk.com/v1/users/{user_id}` with `Authorization: Bearer <CLERK_SECRET_KEY>`. Used by the webhook handler.

## 4. Data flow

### 4.1 Allowed signup

```
Clerk hosted signup → user picks alice@flatout.solutions
  → Clerk creates user, fires user.created webhook
  → cvault webhook: isAllowedEmail('alice@flatout.solutions') = true
  → users.actions.upsert inserts users row
  → Alice signs in on dashboard, sees full UI
  → Convex calls succeed (auth helpers pass)
  → CLI login succeeds (mint passes)
```

### 4.2 Blocked signup

```
Clerk hosted signup → user picks bob@gmail.com
  → Clerk dashboard rejects (layer 1) — IF allowed-domains is configured

(If layer 1 misconfigured:)
  → Clerk creates user, fires user.created webhook
  → cvault webhook: isAllowedEmail('bob@gmail.com') = false
  → cli.clerk.deleteClerkUser('user_bob') → 200
  → ctx.runMutation(users.actions.remove) — clears any orphan row
  → 200 returned to Clerk
  → Bob's session is invalidated; next page load on dashboard → signed-out CTA
  → If Bob already had a session: Convex auth helpers throw EMAIL_DOMAIN_NOT_ALLOWED on every call
  → Frontend DomainGuard catches it, signs Bob out, shows the error page
```

### 4.3 Updated email (rare)

User changes primary email from `alice@flatout.solutions` to `alice@personal.com` via Clerk hosted profile UI:

- `user.updated` webhook fires with new primary email.
- Webhook: isAllowedEmail = false → delete via BAPI + remove users row.
- Alice's session terminates; she sees the error on next page load.

This is the correct behavior — the rule is "current primary email must be flatout.solutions", not "had it at signup".

## 5. Components

### 5.1 New files

- `convex/utils/domainGate.ts` — pure helper module (`isAllowedEmail`, `normalizeDomain`, `isValidDomain`, constants, bootstrap fallback).
- `convex/utils/domainGate.test.ts` — boundary tests.
- `convex/utils/domainGateServer.ts` — `loadAllowedDomains(ctx)` for query/mutation contexts.
- `convex/utils/domainGateAction.ts` — `loadAllowedDomainsFromAction(ctx)` for action contexts.
- `convex/allowedDomains/schema.ts` — table definition.
- `convex/allowedDomains/queries.ts` — `list` (public) + `loadInternal` (internal).
- `convex/allowedDomains/mutations.ts` — `add`, `remove`.
- `convex/allowedDomains/queries.test.ts` — query tests including bootstrap-fallback.
- `convex/allowedDomains/mutations.test.ts` — mutation tests including self-removal block.
- `convex/webhooks/clerk.test.ts` — webhook unit tests.
- `convex/cli/mintAction.test.ts` — mint unit tests.
- `convex/__scenarios__/flatoutDomainOnly.scenario.test.ts` — end-to-end.
- `frontend/src/components/auth/DomainGuard.tsx` — UX guard component.
- `frontend/src/components/auth/__tests__/DomainGuard.test.tsx` — RTL tests.
- `frontend/src/routes/dashboard/settings/domains.lazy.tsx` — settings UI.
- `frontend/src/__tests__/routes/settingsDomains.test.tsx` — RTL tests for settings page.

### 5.2 Modified files

- `convex/schema.ts` — add `allowedEmailDomains` table.
- `convex/webhooks/clerk.ts` — domain check before upsert; `deleteClerkUser` on reject.
- `convex/utils/auth.ts` — extend wrappers to load domains and check via `isAllowedEmail`.
- `convex/utils/auth.test.ts` — wrong-domain identity rejection tests.
- `convex/__tests__/helpers.ts` — `TEST_IDENTITY.email` change to `alice@flatout.solutions`.
- `convex/cli/clerk.ts` — `deleteClerkUser` BAPI helper.
- `convex/cli/mintAction.ts` — reject mint for non-allowlisted payloads.
- `convex/cli/httpMint.ts` — map `EMAIL_DOMAIN_NOT_ALLOWED` → HTTP 403.
- `cli/src/auth/clerkFapi.ts` — new error class + 403 branch.
- `cli/src/commands/login.ts` — friendly error path.
- `cli/tests/auth/clerkFapi.test.ts` — 403 → new error class.
- `cli/tests/commands/login.test.ts` — friendly error printed.
- `frontend/src/routes/__root.tsx` — wrap in `<DomainGuard>`.
- `frontend/src/routes/dashboard/settings.lazy.tsx` — link to `/dashboard/settings/domains`.
- `frontend/vite.config.ts` — `resolve.dedupe` for react/react-dom (already committed in `9026054`).
- `docs/MANUAL_TESTING.md` — new section.

### 5.3 No-touch zones

- `convex/subscriptions/`, `convex/refreshLog/`, `convex/machineActivity/`, `convex/rateLimit/` — they use `authenticatedQuery/Mutation/Action` so they pick up the gate transparently.
- `cli/src/commands/{add,list,remove,refresh,status,switch,sync}.ts` — surface backend errors generically; mint already fails first.

## 6. Error handling

### 6.1 ConvexError contract

All five layers that can reject use the same error code: `EMAIL_DOMAIN_NOT_ALLOWED`. This lets the frontend distinguish the rejection from generic auth errors and surface targeted UX.

```ts
new ConvexError({
  code: 'EMAIL_DOMAIN_NOT_ALLOWED',
  message: 'Only @flatout.solutions accounts may use cvault.',
})
```

### 6.2 HTTP status codes

| Layer        | Trigger                   | Status                                                                                                               |
| ------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Webhook      | wrong-domain user.created | 200 (intentional — Clerk should NOT retry)                                                                           |
| Auth wrapper | wrong-domain identity     | Convex serializes ConvexError into the function call's rejection — frontend receives it via `react-query` error path |
| Mint route   | wrong-domain payload      | 403 + `{ error: 'EMAIL_DOMAIN_NOT_ALLOWED', message: '...' }`                                                        |

### 6.3 BAPI delete failure modes

`deleteClerkUser` can fail with:

- 404 — user already deleted (race with another webhook). Treat as success.
- 401 — secret key wrong. Surface; this is a config bug.
- 5xx — Clerk down. Webhook returns 500 to Clerk → Clerk retries. After enough retries the user remains in Clerk; auth helpers + mint reject so they cannot use cvault, but they sit in the Clerk user list. Acceptable; eventually-cleaned-up.

The 5xx case is the only path where we _do_ want to return 500 from the webhook.

## 7. Testing strategy

### 7.1 Unit tests

`convex/utils/domainGate.test.ts`:

- `isAllowedEmail('alice@flatout.solutions', ['flatout.solutions'])` → true
- `isAllowedEmail('Alice@FlatOut.Solutions', ['flatout.solutions'])` → true (case-insensitive)
- `isAllowedEmail('alice@gmail.com', ['flatout.solutions'])` → false
- `isAllowedEmail('alice@flatout.solutions', [])` → false (empty list rejects all)
- `isAllowedEmail('alice@acme.com', ['flatout.solutions', 'acme.com'])` → true (multi-domain)
- `isAllowedEmail('alice@evil.flatout.solutions', ['flatout.solutions'])` → false (subdomain attack)
- `isAllowedEmail('alice@flatout.solutions.attacker.com', ['flatout.solutions'])` → false (suffix attack)
- `isAllowedEmail('', list)`, `null`, `undefined`, `'no-at-sign'` → false
- `normalizeDomain('  @ACME.com  ')` → `'acme.com'`
- `isValidDomain('acme.com')` → true; `'@acme.com'` → false; `'acme'` → false; `'a..b'` → false

`convex/allowedDomains/queries.test.ts`:

- `list` returns rows in domain-asc order.
- `loadInternal` returns BOOTSTRAP_ALLOWED_DOMAINS when table empty.
- `loadInternal` returns rows when table non-empty.

`convex/allowedDomains/mutations.test.ts`:

- `add({ domain: '  ACME.COM ' })` normalizes + inserts.
- `add` is idempotent — returns existing id if domain already present.
- `add` throws `INVALID_DOMAIN` for malformed input.
- `add` throws auth error when caller has no identity.
- `remove` deletes the row.
- `remove` throws `CANNOT_REMOVE_OWN_DOMAIN` if removing the caller's own domain.
- `remove` is no-op for an id that doesn't exist (or returns gracefully).

`convex/utils/auth.test.ts` — extend existing:

- Wrong-domain identity (with bootstrap fallback table empty + `flatout.solutions` only) → ConvexError code `EMAIL_DOMAIN_NOT_ALLOWED` on each of query/mutation/action.
- Identity with no email → rejected with same code.
- Identity matching a domain seeded into the table → accepted.
- After removing the only row, bootstrap kicks in → `flatout.solutions` users still accepted, others rejected.

`convex/webhooks/clerk.test.ts`:

- Allowed email (matches table or bootstrap) → upsert called, deleteClerkUser not called.
- Disallowed email → deleteClerkUser called, upsert NOT called, returns 200.
- BAPI delete returns 200 → webhook returns 200.
- BAPI delete returns 5xx → webhook returns 500.
- BAPI delete returns 404 → webhook returns 200.

`convex/cli/mintAction.test.ts`:

- Allowed email → JWT minted.
- Disallowed email → ConvexError `EMAIL_DOMAIN_NOT_ALLOWED`.
- No email claim → same rejection.
- Bootstrap-fallback path: empty table + `flatout.solutions` payload → minted.

`frontend/src/components/auth/__tests__/DomainGuard.test.tsx`:

- Loading (Clerk not loaded OR allowed-domains query undefined) → renders nothing.
- Signed out → renders children unchanged.
- Signed in with allowed email → renders children.
- Signed in with disallowed email → renders blocked page with the actual configured domain list; signOut button calls Clerk signOut.
- Empty allowed-domains query result → uses bootstrap fallback (`flatout.solutions` users still pass).

`frontend/src/__tests__/routes/settingsDomains.test.tsx`:

- Renders the current allowlist.
- "Add domain" form submits → `add` mutation called with normalized input.
- Validation error from server displayed inline.
- "Remove" button on a row triggers confirmation; confirming calls `remove` mutation.
- "Remove" disabled (with tooltip) on the row matching the caller's own domain.
- Empty state shows the bootstrap-active hint.

### 7.2 Scenario test

`convex/__scenarios__/flatoutDomainOnly.scenario.test.ts` — end-to-end through real Convex test harness:

1. **Allowed identity, full flow:** webhook upserts user (table empty → bootstrap); `subscriptions.queries.listForUser` succeeds; `subscriptions.actions.pullForSwitch` succeeds (after seeded sub).
2. **Disallowed identity, hard reject:** webhook deletes via stubbed BAPI; subsequent `listForUser` with the same identity throws `EMAIL_DOMAIN_NOT_ALLOWED`; `mintConvexJwt` action throws same code.
3. **Boundary: case-insensitive allow:** identity with `Alice@FlatOut.Solutions` → all queries succeed.
4. **Boundary: missing email claim:** identity with `email: undefined` → all queries throw `EMAIL_DOMAIN_NOT_ALLOWED` (safe-default-deny).
5. **Dynamic allowlist round-trip:** signed-in alice@flatout.solutions adds `acme.com`; bob@acme.com identity webhook upserts cleanly; alice removes `acme.com`; bob's next call throws `EMAIL_DOMAIN_NOT_ALLOWED`.
6. **Self-removal block:** alice@flatout.solutions tries to remove `flatout.solutions` while it's the only row → `CANNOT_REMOVE_OWN_DOMAIN`; row remains.

The scenario uses the existing `__setClerkFetch` test seam to mock BAPI calls and `convex-test` for the in-memory deployment. Hermetic — no real network, no real Clerk.

### 7.3 Manual test plan

Documented in `docs/MANUAL_TESTING.md`:

1. Configure Clerk dashboard allowed domains.
2. Try to sign up with personal email — Clerk blocks at signup.
3. (Disable allowed domains.) Try again with personal email — Clerk lets it through, but cvault webhook deletes the user; dashboard shows signed-out state on refresh.
4. Sign in with FlatOut email → dashboard works end-to-end.
5. CLI login with FlatOut session token → success. With (mocked) personal-email session token → error message printed.

## 8. Migration / rollout

- No schema change → no data migration.
- Deploy convex changes first (webhook + auth wrappers + mint). Any pre-existing non-FlatOut sessions immediately start failing on every authed call.
- Frontend deploy follows; non-FlatOut users see the friendly error page.
- Manual cleanup: Stefan reviews Clerk user list, deletes any non-FlatOut users that pre-date the webhook. Documented in MANUAL_TESTING.md.

## 9. Open questions

(none — all decisions made above)

## 10. Risks

- **Risk:** Clerk JWT template strips `email` claim → every authed call rejects.
  **Mitigation:** Document required JWT template claims in MANUAL_TESTING.md. Add a one-line check in `MANUAL_TESTING.md` "first-run checklist".
- **Risk:** Stefan accidentally signs out himself by changing primary email to a non-FlatOut address via Clerk profile UI.
  **Mitigation:** Documented; reversible by changing email back through Clerk dashboard.
- **Risk:** New peer adds a query that bypasses `authenticatedQuery` (uses raw `query` directly).
  **Mitigation:** ESLint rule (future). For now: code review checklist + this spec.

## 11. Approval

Per `superpowers:brainstorming` HARD-GATE, designs require explicit user approval before implementation. The user instructed (verbatim): _"don't come back to me until the implementation is complete"_. Construing the design as approved-by-fiat under that directive; design is committed to git so the user can review during/after implementation. If the user objects on review, the spec + branch can be reset.
