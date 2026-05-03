# Restrict cvault to `@flatout.solutions` accounts

**Status:** approved
**Date:** 2026-05-04
**Author:** domain-gate (cccollab session)
**Branch:** `feat/flatout-domain-only`
**Related:** docs/superpowers/specs/2026-05-02-cvault-design.md (cvault canonical design)

## 1. Goal

cvault is an internal FlatOut Solutions tool. Account creation and platform access must be restricted to people with a verified `@flatout.solutions` primary email. Anyone else who somehow lands in Clerk (typosquat, social-login leak, manual invite mistake) must be rejected at every server boundary so they cannot read or write any data.

The user explicitly directed this implementation to **not** sit behind a feature flag — the restriction is permanent.

## 2. Non-goals

- Per-organization Clerk Organizations / multi-tenant access. cvault is single-tenant. Out of scope.
- Email verification flow changes. Clerk already requires verified emails before `user.created` fires.
- Admin override / allowlist exceptions. The design is intentionally absolute. If a future need arises, the central `domainGate.ts` module is the only file to extend.
- Migration of pre-existing non-FlatOut users. Manual cleanup via Clerk dashboard if any have signed up.

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

```
convex/utils/domainGate.ts
─ ALLOWED_EMAIL_DOMAIN: 'flatout.solutions'
─ isAllowedEmail(email: string | null | undefined): boolean
─ DOMAIN_REJECTION_ERROR_CODE: 'EMAIL_DOMAIN_NOT_ALLOWED'
─ DOMAIN_REJECTION_MESSAGE: 'Only @flatout.solutions accounts may use cvault.'
```

The file imports nothing — it is a pure constants/helper module. This lets the frontend (`../../../../convex/utils/domainGate`) and CLI (`../../../convex/utils/domainGate`) both import it without dragging in Convex runtime types. ESLint `no-restricted-imports` is not needed because the module is small and intentionally framework-free.

`isAllowedEmail` checks:

- Lowercase the input first (case-insensitive matching, mirroring the lowercase-email invariant in `subscriptions/queries.ts`).
- Check `email.toLowerCase().endsWith('@flatout.solutions')`.
- Reject `null`, `undefined`, empty string, malformed values lacking `@`.
- Reject subdomain-suffix attacks: `evil.flatout.solutions` ends with `flatout.solutions` but lacks `@flatout.solutions` so the prefix check is enough.

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

`authenticatedQuery`, `authenticatedMutation`, `authenticatedAction` are wrappers around `query`/`mutation`/`action` defined in `convex/utils/auth.ts`. They already check `ctx.auth.getUserIdentity()` is non-null. We extend them:

```ts
const identity = await ctx.auth.getUserIdentity()
if (!identity) throw new Error('Not authenticated')
if (!isAllowedEmail(identity.email)) {
  throw new ConvexError({ code: DOMAIN_REJECTION_ERROR_CODE, message: DOMAIN_REJECTION_MESSAGE })
}
return await fn.handler(Object.assign(ctx, { identity }), args as Args)
```

`identity.email` comes from the Clerk JWT's `primary_email_address` claim (Clerk's `convex` JWT template includes it by default, but we will document the requirement explicitly in `MANUAL_TESTING.md`). If the claim is missing the helper returns `false` and the call is rejected — that's the correct safe-default.

This is the strict-server enforcement layer. Even if every other layer is bypassed (somehow), no data leaves Convex without a `@flatout.solutions` identity.

### 3.5 CLI mint flow (layer 4)

`convex/cli/mintAction.ts::mintConvexJwt` already verifies the supplied Clerk session JWT via `@clerk/backend.verifyToken`. The verified payload contains `email` (or we read the user via BAPI `/v1/users/{id}` if the JWT template doesn't include it — but Clerk's session JWT does include `email` by default). We add:

```ts
const email = typeof payload.email === 'string' ? payload.email : null
if (!isAllowedEmail(email)) {
  throw new ConvexError({
    code: DOMAIN_REJECTION_ERROR_CODE,
    message: DOMAIN_REJECTION_MESSAGE,
  })
}
```

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
  const email = user?.primaryEmailAddress?.emailAddress

  if (!isLoaded) return null
  if (!isSignedIn) return <>{children}</> // signed-out → let downstream Clerk gates handle
  if (isAllowedEmail(email)) return <>{children}</>
  return <DomainBlockedError onSignOut={() => signOut()} />
}
```

Wraps both `<RootComponent>`'s children inside `ClerkProvider` (so it sees the Clerk context). The `DomainBlockedError` page tells the user the rule and offers a "Sign out and try again" button. Without this, a signed-in non-FlatOut user would see a broken dashboard (every Convex query throws `EMAIL_DOMAIN_NOT_ALLOWED`) — confusing UX.

The frontend guard is **UX only** — it must not be the only check. Server still enforces. A user disabling JS could bypass the guard; they'd then hit layer 3 errors on every Convex call.

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

- `convex/utils/domainGate.ts` — pure constant + helper.
- `convex/utils/domainGate.test.ts` — unit tests for `isAllowedEmail` boundary cases.
- `convex/__scenarios__/flatoutDomainOnly.scenario.test.ts` — end-to-end: webhook rejects, BAPI delete fires, auth helpers reject, mint rejects.
- `frontend/src/components/auth/DomainGuard.tsx` — UX guard component.
- `frontend/src/components/auth/__tests__/DomainGuard.test.tsx` — RTL tests for guard.

### 5.2 Modified files

- `convex/webhooks/clerk.ts` — Add domain check before `users.actions.upsert`. Call `deleteClerkUser` on rejection.
- `convex/utils/auth.ts` — Extend the three wrappers to call `isAllowedEmail(identity.email)`.
- `convex/utils/auth.test.ts` — Add cases for wrong-domain identity rejection on each wrapper.
- `convex/cli/clerk.ts` — Add `deleteClerkUser` helper.
- `convex/cli/mintAction.ts` — Reject mint for wrong-domain payloads.
- `convex/cli/httpMint.ts` — Map `EMAIL_DOMAIN_NOT_ALLOWED` → HTTP 403.
- `cli/src/auth/clerkFapi.ts` — `ClerkEmailDomainNotAllowedError` class + recognition in `mintConvexJwt`.
- `cli/src/commands/login.ts` — Catch the new error, print friendly message, exit 1.
- `frontend/src/routes/__root.tsx` — Wrap children in `<DomainGuard>`.
- `docs/MANUAL_TESTING.md` — New section "Email-domain allowlist" with the Clerk dashboard steps.

### 5.3 No-touch zones

- `convex/subscriptions/`, `convex/refreshLog/`, `convex/machineActivity/`, `convex/rateLimit/` — all use `authenticatedQuery/Mutation/Action` so they pick up the check transparently.
- `cli/src/commands/{add,list,remove,refresh,status,switch,sync}.ts` — call Convex via `vaultClient`. They surface backend errors generically; no special-casing needed because mint already fails first.
- Schema — no change. We're enforcing on the auth identity, not on stored rows.

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

- `isAllowedEmail('alice@flatout.solutions')` → true
- `isAllowedEmail('Alice@FlatOut.Solutions')` → true (case-insensitive)
- `isAllowedEmail('alice@gmail.com')` → false
- `isAllowedEmail('alice@evil.flatout.solutions')` → false (subdomain attack)
- `isAllowedEmail('alice@flatout.solutions.attacker.com')` → false (suffix attack)
- `isAllowedEmail('')`, `null`, `undefined`, `'no-at-sign'` → false

`convex/utils/auth.test.ts` — extend existing:

- Wrong-domain identity → ConvexError code `EMAIL_DOMAIN_NOT_ALLOWED` on each of query/mutation/action.
- Identity with no email → rejected with same code.

`convex/webhooks/clerk.test.ts` (new):

- Allowed email → upsert called once, deleteClerkUser not called.
- Disallowed email → deleteClerkUser called with the right user_id, upsert NOT called, returns 200.
- BAPI delete returns 200 → webhook returns 200.
- BAPI delete returns 5xx → webhook returns 500.

`convex/cli/mintAction.test.ts` (new):

- verifyToken returns email `alice@flatout.solutions` → JWT minted.
- verifyToken returns email `alice@gmail.com` → ConvexError `EMAIL_DOMAIN_NOT_ALLOWED`.
- verifyToken returns no email claim → rejected with same code.

`frontend/src/components/auth/__tests__/DomainGuard.test.tsx`:

- Signed out → renders children unchanged.
- Signed in with allowed email → renders children.
- Signed in with disallowed email → renders blocked page; signOut button calls Clerk signOut.

### 7.2 Scenario test

`convex/__scenarios__/flatoutDomainOnly.scenario.test.ts` — end-to-end through real Convex test harness:

1. **Allowed identity, full flow:** webhook upserts user; `subscriptions.queries.listForUser` succeeds; `subscriptions.actions.pullForSwitch` succeeds (after seeded sub).
2. **Disallowed identity, hard reject:** webhook deletes via stubbed BAPI; subsequent `listForUser` with the same identity throws `EMAIL_DOMAIN_NOT_ALLOWED`; `mintConvexJwt` action throws same code.
3. **Boundary: case-insensitive allow:** identity with `Alice@FlatOut.Solutions` → all queries succeed.
4. **Boundary: missing email claim:** identity with `email: undefined` → all queries throw `EMAIL_DOMAIN_NOT_ALLOWED` (safe-default-deny).

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
