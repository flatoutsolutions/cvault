---
audit-date: 2026-05-02
auditor: claude opus 4.7 (read-only convex security audit)
commit-hash: (none — repo has no commits yet; main branch points to no commit)
scope: convex/ backend (committed code), referencing spec docs/superpowers/specs/2026-05-02-cvault-design.md
mode: read-only — no code modified, no commands run that mutate state
---

# cvault — Convex backend security findings

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 6 |
| Low | 6 |
| Info | 5 |

The Convex backend implements the spec faithfully, with strong patterns
(authenticated wrappers, internal-only schedule targets, AES-256-GCM with
key/nonce length asserts, server-side encryption so the CLI never holds
the master key, ciphertext stripping in public queries, OAuth-token regex
redaction in `refreshLog.error`, lease CAS with holder-token enforcement,
ownership re-verification in `requestRefresh`, IP hashed not stored, no
keychain/keytar deps).

The single notable issue (#H1) is in the **frontend** `/cli/link` route,
strictly out of the requested Convex scope, but it materially undermines
the CLI auth flow (spec §7) so it is reported here rather than dropped.
Everything else is medium-or-below polish.

---

## Findings table

| # | Sev | File:line | Issue | Recommendation |
|---|---|---|---|---|
| H1 | High | frontend/src/routes/cli/link.tsx:35,78 | `redirect` search param is validated as `z.string().url()` only — any URL is accepted. The page auto-POSTs the freshly minted Clerk sign-in token to whatever URL is in `redirect`, so a phishing link `/cli/link?redirect=https://attacker.example.com&state=X` opened by a signed-in user lets the attacker capture a single-use sign-in token bound to that user_id and complete a Clerk sign-in as them. The CLI side does bind 127.0.0.1 only; the dashboard side does not enforce the matching constraint on the destination. | Restrict `redirect` to `http://127.0.0.1:<port>/...` or `http://[::1]:<port>/...`. Reject anything else in `validateSearch` (hostname check + `http:` only + path allowlist). Optionally add a click-to-confirm step ("send token to 127.0.0.1:54321?") so a stolen URL alone can't drive the POST. Consider also moving the POST to a server-side route handler that re-checks the redirect host. |
| M1 | Medium | convex/subscriptions/actions.ts:219 (refreshOAuthToken) and 342 (fetchUsageForSub) | `decrypt()` is called without a try/catch. A GCM auth-tag mismatch (corrupt ciphertext, key rotated, nonce mangled) throws and the action fails. In `refreshOAuthToken` the lease is left held until the 30s TTL expires (releaseRefreshLease never runs), and no `refreshLog` row is inserted, so the user sees no `corrupt — re-add` signal. Spec §10 explicitly calls for "Decrypt failure (GCM auth tag) → Throw, log error w/ subId; surface as 'creds corrupt — re-add'". | Wrap the decrypt in try/catch; on failure, run `releaseRefreshLease` (or `markReloginRequired` since recovery requires re-add anyway), insert a `refreshLog` row with `outcome:'failure', error:'decrypt failed; subscription credentials corrupt'` after `redactTokens()`, and return null. For `fetchUsageForSub`, same treatment but no lease and no log row needed (next tick will retry — but if it fails forever the cron silently masks it). |
| M2 | Medium | convex/subscriptions/crons.ts:33-40 and 54-60 | `Promise.all` over per-sub fanout means one throwing action rejects the whole cron run, which Convex surfaces as a failed cron in dashboard logs but masks per-sub root-cause. Per spec §10 the usage cron should "skip cycle silently" per-sub on failure — `Promise.all` doesn't do that. | Switch to `Promise.allSettled`. The per-action handlers already self-log via `refreshLog` for refresh, and per spec usage failures are silent — `allSettled` matches both. |
| M3 | Medium | convex/cli/httpSync.ts (whole file) | `GET /api/cli/sync` returns the **plaintext blob for every active sub** in a single response. There is no rate limit, no audit row, and no per-call idempotency. A leaked Clerk JWT (e.g., from a compromised laptop's `~/.vault/session.json`) gives an attacker the full credential dump in one request. Spec §12 lists "per-user mutation rate limit deferred to v2" but a bulk-extract endpoint deserves stronger protection regardless. | (a) Insert a `machineActivity` row with `action:'pull'` for the bulk-pull (currently only the per-sub `pullForSwitch` action records activity). (b) Add `convex-helpers` rate limiting (e.g., 1 bulk pull per machine per minute) or require an explicit query parameter that the CLI passes only on first-bootstrap. (c) Consider adding a CLI-issued device token with shorter lifetime than the Clerk session JWT, even if v2. |
| M4 | Medium | convex/subscriptions/actions.ts:80-86 (pullForSwitch records activity) vs. all other public mutations / actions | Only `pullForSwitch` writes a `machineActivity` row. `softRemove`, `rename`, `upsertFromPlaintext`, `requestRefresh`, `revokeSession`, and the bulk `/api/cli/sync` endpoint do not. Per spec §4 the action enum already has `add`, `remove`, `refresh` (not just `pull` and `switch`) — these are intended to be recorded. Without these, the audit feed at `/dashboard/audit` is missing entire categories of events. | Have each authenticated public mutation/action (or a thin shared helper) emit a corresponding `machineActivity.record` call. Consider moving the activity recording into the `authenticatedMutation` / `authenticatedAction` wrappers via a metadata arg so it's centralised. |
| M5 | Medium | convex/machineActivity/mutations.ts and all callers | The mutation accepts `rawIp` and hashes it, but **no caller ever passes `rawIp`**. (a) `pullForSwitch` is invoked over WebSocket and has no access to the raw HTTP request. (b) `cliSyncHandler` (httpAction) does have access to `request` and could read `cf-connecting-ip` / `x-forwarded-for`, but it doesn't, and it doesn't record activity at all (M4). Result: every audit row's `ipHash` is `undefined`. | Either (a) drop the `rawIp` arg + `ipHash` field as YAGNI, or (b) wire `cliSyncHandler` (and a future HTTP route used by mutations) to pass `request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()` to `record`. Don't leave dead code that suggests an audit feature that never fires. |
| M6 | Medium | convex/users/actions.ts:13, convex/organizations/actions.ts:18, convex/organizationMembers/actions.ts:28,47 | Internal Clerk-webhook upsert mutations validate args as `v.any() as Validator<UserJSON>`. Even though the webhook handler verifies an svix signature first, the internal mutation has no contract enforcement — anything that calls it via `internal.users.actions.upsert` skips schema validation. The cast also violates the project's "no `as any` / no type-bypass" rule. | Define a strict `v.object({...})` validator matching the subset of `UserJSON` the handler reads (id, first_name, last_name, image_url, email_addresses, primary_email_address_id). Same for organisations and memberships. This both tightens types and protects against a future programming mistake that calls these internal mutations with mis-shaped data. (Pre-existing Blueprint code, not strictly cvault — but it's in the audited tree.) |
| L1 | Low | convex/subscriptions/actions.ts:78-79 | `(identity as { sid?: unknown }).sid` reads a Clerk-specific JWT claim. The cast is "safe" but the project's type-safety rule prefers explicit narrowing helpers over inline structural casts. Also: the fallback string `'unknown-session'` becomes a sentinel that, given enough callers, could collide and degrade the per-machine drilldown query. | Define a small `getClerkSessionId(identity: UserIdentity): string | null` helper in `utils/auth.ts` that reads the optional `sid` claim with proper narrowing, and have callers either skip recording activity (when sid is null) or pass `clerkSessionId: null` and store it as `v.optional(v.string())`. |
| L2 | Low | convex/subscriptions/actions.ts:185 (refreshOAuthToken) | The action uses Anthropic's OAuth token URL via the `anthropic.ts` wrapper, but does not pass `User-Agent` or `Content-Type` overrides through the test seam in a way that survives Anthropic adding header requirements server-side. If Anthropic starts requiring `anthropic-version` or a different beta header on the token endpoint, refreshes will silently 4xx-loop until someone reads the spec § comment. | Add an integration test (under `__scenarios__/`) that runs the real refresh against a sandbox token. Spec §11 already plans for this but flagged as "deferred". Track in IMPLEMENTATION_NOTES "open backend issues". |
| L3 | Low | convex/subscriptions/anthropic.ts:13-42 (`__setAnthropicFetch`, `__setRandomBytesForTest`) | Test seams via module-level `_fetch` / `_randomBytes` mutate process-global state. If two test files run concurrently in the same Vitest worker (Vitest 4 supports parallel files within a project), one test's stub can leak into another. Tests already do `afterEach(() => __setAnthropicFetch(undefined))` but parallel-within-file ordering is not guaranteed. | (Acceptable as a v1 pragma; flagging only.) Long-term, prefer a `fetch` parameter passed into `refreshAccessToken(refreshToken, opts?: { fetch })`, pure-functional. |
| L4 | Low | convex/subscriptions/redact.ts:14 | The OAuth-token regex `sk-ant-[a-z]+\d+-[A-Za-z0-9_-]{20,}` has no global anchor reset and uses the `g` flag — a `RegExp.prototype.replace(string, replacement)` is fine, but if anyone ever uses `.test(...)` on the same regex literal repeatedly (e.g., a future `if (TOKEN_RE.test(msg))` guard), the `lastIndex` state will alternate true/false. Also, the regex assumes the prefix is exactly `sk-ant-{lowercase}{digits}-`; if Anthropic ever issues `sk-ant-API01-...` (uppercase prefix), redaction silently fails. | (a) Either freeze the literal as a stateless `() => /.../g` factory or document the constraint. (b) Loosen the prefix-letters class to `[A-Za-z]+` to be future-proof. (c) Add a property test that randomised token-shaped strings always redact. |
| L5 | Low | convex/cli/actions.ts:34-38 | When `mintSignInToken` fails, the ConvexError message includes `result.body.slice(0, 200)`. Clerk error bodies can include user emails or session IDs; this is fine for the dashboard caller (who is the user themself), but the action also throws this back through Convex which surfaces it client-side. Sensitive Clerk-side messages (e.g., "user is locked out", account-takeover suspicions) get shown to the very actor under attack. Same in `revokeClerkSession` error path. | Either truncate to a generic `Clerk Backend API ${status}` and log the full body server-side via `console.error` (Convex log dashboard, not client), OR pre-filter the body for a small allowlist of fields. |
| L6 | Low | convex/utils/auth.ts:50-75 | `getIdentity(ctx)` does runtime narrowing, then `id as UserIdentity`. The cast is OK because the wrapper attached the same shape `ctx.auth.getUserIdentity()` returned, but the failure mode if a future refactor lands a non-augmented ctx in this path is silent — the cast hides that the augmented ctx is just a hope. | (a) Replace the `as` cast with a checked construction `{ subject, issuer, tokenIdentifier, ... }` so missing fields short-circuit. (b) Or, fix the type-cast issue at source by writing a `customQuery` helper that statically intersects the augmented ctx (deferred per IMPLEMENTATION_NOTES — acceptable). |
| I1 | Info | convex/crons.ts | Both crons reference `internal.subscriptions.crons.*` (good — never `api.*`). Verified no `api.*` reference in cron schedule or `ctx.scheduler.runAfter`. |
| I2 | Info | convex/subscriptions/crypto.ts:23-42 | Master key load asserts (a) env var present, (b) base64-decodable, (c) exactly 32 bytes. Fresh 12-byte nonce from `node:crypto.randomBytes` per write. Auth-tag mismatch throws on decrypt (Node `decipher.final()` raises). Test coverage in `crypto.node.test.ts` covers both tampered ciphertext and tampered nonce. |
| I3 | Info | convex/subscriptions/queries.ts:48-53, 69 | `toMeta()` strips `ciphertext` + `nonce` before returning. Public query `listForUser` and `getMetaByEmail` cannot return the encrypted blob over the wire. Defense-in-depth check covered by `queries.test.ts` "strips ciphertext and nonce from the response payload". |
| I4 | Info | convex/cli/actions.ts:32 | `mintSignInToken(userId, 600)` — TTL is 600s, matching spec §7 / brief recommendation. Test asserts `≤ 900`, looser than production but production passes 600. |
| I5 | Info | package.json — no `keytar`, `node-keychain`, `macos-keychain`, or any native-keychain dependency. Convex deployment never tries to read the user's Mac Keychain (correctly — that lives on the user's machine, not the cloud). |

---

## Per-area summaries

### 1. Encryption envelope (spec §6)

**Status: clean.**

- `convex/subscriptions/crypto.ts` reads `VAULT_AES_KEY` from env, never hardcoded. Throws if absent or non-base64.
- Key length asserted at exactly 32 bytes after base64 decode (line 38).
- Per-write 12-byte nonce via `node:crypto.randomBytes(12)` (line 58).
- `encrypt()` uses `aes-256-gcm`, returns `[ciphertext || authTag]` bundle.
- `decrypt()` extracts the trailing 16-byte tag, sets it on the decipher; Node's GCM impl throws on tag mismatch (covered by `crypto.node.test.ts`).
- The crypto module is gated to the Node runtime via `'use node'`. Public mutations do NOT import it; only Node actions (`subscriptions/actions.ts`, `cli/syncAction.ts`) do.
- The CLI never sees the master key — `upsertFromPlaintext` is a public action that encrypts server-side and delegates to internal `upsertEncrypted` mutation.

### 2. Token redaction (spec §10, §12)

**Status: applied where required; minor coverage gaps.**

- `redactTokens()` regex `/sk-ant-[a-z]+\d+-[A-Za-z0-9_-]{20,}/g` covers observed access-token (`sk-ant-oat01-...`) and refresh-token (`sk-ant-ort01-...`) shapes.
- Applied in `refreshOAuthToken` action error path before `refreshLog.insert` (line 274).
- No `console.log`/`console.error` in any token-handling path leaks plaintext. `validateRequest.ts:16` logs only the verification error object (no token). `webhooks/clerk.ts:59` logs `event.type` only. `users/actions.ts:46` and `organizations/actions.ts:46` log only Clerk IDs.
- L4 flags a future-proofing concern with the regex prefix character class.

### 3. Auth gating (spec §5, §12)

**Status: clean.**

- All public queries/mutations/actions are routed through `authenticatedQuery` / `authenticatedMutation` / `authenticatedAction` (`utils/auth.ts`).
- Wrappers throw "Not authenticated" when `ctx.auth.getUserIdentity()` returns null (verified via `utils/auth.test.ts`).
- Cron-scheduled functions are `internalAction` — verified no `api.*` references in `crons.ts` or `ctx.scheduler.runAfter` calls (no `runAfter` calls exist).
- `internalMutation` / `internalAction` / `internalQuery` used correctly for: `tryAcquireRefreshLease`, `releaseRefreshLease`, `commitRefreshedTokens`, `patchUsage`, `markReloginRequired`, `upsertEncrypted`, `refreshOAuthToken`, `fetchUsageForSub`, `refreshLog.insert`, `machineActivity.record`, all `subscriptions/internalReads.ts`, all `cli/internalReads.ts`, `cli/syncAction.buildBundleForUser`.
- The HTTP route `/api/cli/sync` (`cli/httpSync.ts`) checks `ctx.auth.getUserIdentity()` and 401s if absent.

### 4. User isolation

**Status: clean.**

- Every public query / mutation that reads `subscriptions`, `refreshLog`, `machineActivity` resolves the current user via `getCurrentUserOrThrowFromIdentity(ctx, getIdentity(ctx).subject)` and scopes via `byUser*` indexes.
- `refreshLog.queries.recentForSubscription` defends against by-id-only abuse: it `ctx.db.get(subscriptionId)` and returns `[]` if `sub.userId !== user._id` (line 43). Good.
- `subscriptions.actions.requestRefresh` does the same: looks up sub via `getSubscriptionByIdForActor` which scopes by externalId + verifies userId match (line 162-171). Good.
- `subscriptions.actions.pullForSwitch` uses `getSubscriptionForActor` which scopes by externalId. Good.
- The internal `getSubscriptionRaw` (`internalReads.ts:39`) does NOT scope by user — it's only callable from internal actions, which themselves are called by the cron (no actor) or by user-scoped wrappers, so this is safe by composition.
- Cross-user test exists: `refresh.test.ts` "rejects requestRefresh when the caller does not own the sub" passes.

### 5. Refresh lease race protection (spec §9)

**Status: clean.**

- `tryAcquireRefreshLease` is a single Convex `internalMutation` — atomic by definition (Convex mutations run as serialised transactions).
- TTL check `sub.refreshLeaseUntil > now` is correct; a lease whose TTL has expired is treated as available (verified by `mutations.test.ts` "grants the lease again after the previous lease has expired").
- `releaseRefreshLease` only clears the lease when `sub.refreshLeaseHolder === holderToken` (line 258); mismatch is silently no-op'd (correctly defensive).
- `commitRefreshedTokens` throws `LEASE_LOST` if holder mismatch (line 287-292) — strong invariant, prevents a stale winner from clobbering a fresher rotation.
- Loser path in `refreshOAuthToken` action (lines 199-210): sleep 1s, re-query, if `expiresAt > now + 5min` (winner committed) return null; else also return null without log row. Bounded — does not retry forever.
- 30s lease TTL covers action timeouts and decrypt-throw (M1).
- Holder token is `node:crypto.randomBytes(16).toString('hex')` (anthropic.ts:210-212), a fresh 128-bit token per attempt.

### 6. Anthropic upstream calls

**Status: clean.**

- POST URL is `https://platform.claude.com/v1/oauth/token` (anthropic.ts:15), per `docs/research/anthropic-oauth-refresh.md`.
- Refresh POST headers: `Content-Type: application/json` and `User-Agent` ONLY — no `anthropic-beta`, no `Authorization` (refresh token is in body). Matches research brief §"Headers".
- Usage GET headers: `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`, `User-Agent` — correctly applies the beta header only on usage, not on refresh.
- 400 / 401 with `error: "invalid_grant"` body → `outcome: 'reloginRequired'` (lines 252-264). Bare 401 also treated as reloginRequired conservatively.
- 4xx (other) / 5xx / network → `outcome: 'failure'`, lease released, next cron tick retries. No exponential backoff per spec (deferred to v2 — flagged in IMPLEMENTATION_NOTES).
- 429 on usage → silent skip (`fetchUsageForSub` returns null when `!result.ok`), retry next 5-min tick.
- Anthropic 4xx/5xx response bodies are sliced to 500 chars and run through `redactTokens()` before persist.

### 7. CLI auth flow (spec §7)

**Status: backend OK; frontend has H1.**

- `api.cli.actions.startLink` is `authenticatedAction` — gates on `ctx.auth.getUserIdentity()` BEFORE creating the token (line 28 verifies via `getIdentity(ctx)`).
- TTL passed to Clerk is 600s (line 32) — meets spec `expires_in_seconds ≤ 600`.
- Token is returned to the dashboard caller; the dashboard then POSTs it to a localhost callback.
- CLI listener is bound `127.0.0.1` via `Bun.serve({ hostname: '127.0.0.1', ... })` (callbackServer.ts:80), NOT 0.0.0.0. Constant-time state comparison via `node:crypto.timingSafeEqual` (line 103). 2-minute hard timeout on the callback.
- **HOWEVER** the dashboard `/cli/link` page accepts ANY URL as `redirect`, not just localhost — see H1.

### 8. Logs

**Status: clean.**

- No `console.log` in any token-handling path.
- `console.warn` and `console.error` calls in webhook handlers and validateRequest log only IDs / event types / verification errors — no tokens.
- `refreshLog.error` field is run through `redactTokens()` in the action layer (verified by `refresh.test.ts` "redacts OAuth-token-shaped substrings from the error log").
- 4xx/5xx response bodies are truncated to 500 chars and redacted.
- `machineActivity` only stores `userId`, `clerkSessionId` (Clerk session id, not a token), action, optional `subscriptionId`, `at`, optional `ipHash` — no plaintext.

### 9. Argument validation

**Status: mostly clean (M6 about Clerk webhooks).**

- Every public function has `args:` validators (`v.object`, `v.id('subscriptions')`, `v.string()`, `v.union(v.literal(...))`, etc.).
- Internal mutations also use strict validators (`tryAcquireRefreshLease`, `commitRefreshedTokens`, etc.).
- `refreshLog.insert` accepts `outcome: v.union(v.literal('success'|'failure'|'reloginRequired'))` — strict.
- `machineActivity.record` accepts `action: v.union(v.literal('switch'|'add'|'pull'|'remove'|'refresh'))` — strict.
- The single `v.any()` use is the Clerk-webhook upserts (`users/actions.ts:14`, `organizations/actions.ts:18`, `organizationMembers/actions.ts:28,47`) — see M6.

### 10. Rate limiting

**Status: not applied; flagged as v2 in spec §12 — confirmed.**

- No `convex-helpers` rate limiter or any rate-limit primitive in the codebase.
- Spec §12 explicitly defers per-user mutation rate limiting to v2.
- For v2: `requestRefresh` and `upsertFromPlaintext` are the most attacker-attractive endpoints (force Anthropic refresh of any of your own subs; cheap for caller, expensive for upstream). M3 also flags `/api/cli/sync` as a bulk-extract surface that deserves rate limiting before v2.

### 11. Dependencies

**Status: clean.**

- `package.json` lists no `keytar`, `node-keychain`, `node-mac-keychain`, or any native-bridge that suggests reading the user's Mac Keychain from Convex. Confirmed: the Convex deployment never tries to access user-machine state — that's the CLI's job.
- All deps are standard Blueprint 2.0 stack (Clerk, Convex, TanStack Start, Tailwind, Radix, Vitest, etc.) plus svix for webhook verification.

---

## Open questions / things I couldn't audit because the code isn't there yet

1. **Refresh-cycle scenario test** — spec §11 calls for `__scenarios__/refreshCycle.scenario.ts` gated on `VAULT_TEST_REFRESH_TOKEN`. IMPLEMENTATION_NOTES marks this as deferred. Without it, the Anthropic wire contract is only mock-tested.

2. **The `startLink` `state` argument** is accepted and immediately discarded server-side (`void args.state`). The dashboard echoes it back to the localhost callback for CLI correlation. This means the Convex action provides no anti-replay or anti-CSRF guarantee on the state itself — security relies entirely on (a) the Clerk session that called `startLink` being legitimate, and (b) the dashboard JS POSTing only to the user-confirmed `redirect`. Once H1 is fixed, this becomes acceptable; until then, the action could optionally cache and bind `(state → user_id, expiresAt)` for ~10 min so a stolen-link attacker who somehow got both the state nonce AND the sign-in token would also need to re-issue from the same Clerk session.

3. **Frontend dashboard routes** for `/dashboard`, `/dashboard/audit`, `/dashboard/machines` — out of audit scope (Convex only) but they consume the audited APIs. UI-side authorization (e.g., not exposing other users' subs in any client cache) was not audited.

4. **CLI Bun-runtime code** under `cli/src/` — out of explicit audit scope. The `callbackServer.ts` (binds 127.0.0.1, timing-safe state, 2-min timeout) was sampled and looks correct.

5. **CI / deploy paths** — `.github/workflows/release-cli.yml`, Convex env-var setting, GitHub repo secrets — not audited.

6. **Live deployment configuration** — whether `VAULT_AES_KEY` is actually set on the prod Convex deploy, whether `CLERK_SECRET_KEY` is present, whether the Clerk JWT template is the `convex` one — not auditable from code.

7. **Pre-existing Blueprint code** — `users/actions.ts`, `organizations/actions.ts`, `organizationMembers/actions.ts`, `webhooks/clerk.ts`, `utils/validateRequest.ts` — these are Blueprint defaults; M6 flags the `v.any()` validator on Clerk-webhook upserts, but this predates cvault and is shared with all Blueprint projects.
