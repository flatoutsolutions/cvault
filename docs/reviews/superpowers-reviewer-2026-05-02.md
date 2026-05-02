# cvault — Superpowers Code Review

**Date:** 2026-05-02
**Reviewer:** Senior Code Reviewer (superpowers:code-reviewer)
**Spec:** `docs/superpowers/specs/2026-05-02-cvault-design.md`
**Build report under review:** team-lead's claim of 122 root tests + 117 CLI tests + 0 lint errors + 0 typecheck errors + clean Bun-compile.

---

## 0. Verification — what I re-ran myself

Per `superpowers:verification-before-completion`, I re-ran every gate the team-lead claimed and quote actual outputs.

| Command | Result |
|---|---|
| `yarn test` (root) | `Test Files 23 passed (23)`, `Tests 122 passed (122)`, duration 2.10s. **CONFIRMED.** |
| `yarn lint:check` | exit 0, no output. **CONFIRMED.** |
| `npx convex dev --once --typecheck enable` | `Convex functions ready! (4.36s)`, exit 0. **CONFIRMED.** |
| `npx tsc --noEmit -p tsconfig.app.json` | exit 0, no output. **CONFIRMED.** |
| `cd cli && bunx --bun vitest run` (yarn rejects cli/ as non-workspace, used the underlying script directly) | `Test Files 18 passed (18)`, `Tests 117 passed (117)`, duration 377ms. **CONFIRMED.** |
| `cd cli && bunx tsc --noEmit` | exit 0. **CONFIRMED.** |
| `cd cli && bun build --compile --target=bun-darwin-arm64 ./src/index.ts --outfile /tmp/cvault-test-build` | 38 modules, 95ms compile, 59 MB binary. **CONFIRMED.** |

The team-lead's headline numbers and gates are honest. What follows is everything those gates do not catch.

---

## 1. Summary

| Severity | Count |
|---|---|
| Critical | 2 |
| Important | 8 |
| Suggestion | 7 |

**Overall recommendation: REQUEST CHANGES.**

The Convex backend is largely faithful to the spec, well-tested, and has appropriate defense-in-depth (authenticatedWrappers, internal-only schedule targets, AES-256-GCM with proper invariants, ciphertext stripping in queries, OAuth-token redaction, lease CAS, IP hashing). Encryption envelope and refresh-race protection are in particularly good shape — the spec invariants in §6 and §9 are all satisfied and tested.

However, **two critical end-to-end paths are wired wrong** and a green test suite hides both because the CLI tests stub the typed Convex client and the frontend tests stub the Convex hooks. The bench-test invariants pass; the wire contract between layers does not. Specifically:

1. **`cvault refresh` cannot work** — CLI calls a Convex action by a name the backend never exported (`refreshOAuthTokenForUser`) and with the wrong arg shape (`{slotOrEmail}` vs the backend's `{subId}`).
2. **Dashboard "Force Refresh" button is a 250 ms no-op** — it `console.warn`s about a missing backend action that the backend has, in fact, shipped (`requestRefresh`).

The build report's "0 lint, 0 typecheck, 239 tests" correctly describes the per-layer state. It does not describe whether layers can talk to each other, and they currently can't on the refresh paths. That is a v1-blocking gap.

The frontend `/cli/link` route also has a high-severity open redirect already flagged in `docs/research/security-findings.md` (#H1). It belongs in the same critical bucket — the CLI auth flow's localhost-binding work is undone by a server-side dashboard page that POSTs the freshly minted Clerk sign-in token to any `redirect=` URL.

---

## 2. Critical findings (must fix before v1)

### C1 — `cvault refresh` calls a Convex action that does not exist

**File:** `cli/src/commands/refresh.ts:28-33`

The CLI sends:

```ts
const ref = {
  _name: 'subscriptions/actions:refreshOAuthTokenForUser',
} as unknown as Parameters<typeof client.action>[0]

await client.action(ref, { slotOrEmail: opts.slotOrEmail } as never)
```

Backend exports (`convex/subscriptions/actions.ts`):

| Export | Type | Args |
|---|---|---|
| `requestRefresh` | `authenticatedAction` | `{ subId: v.id('subscriptions') }` |
| `refreshOAuthToken` | `internalAction` (cron only) | `{ subId, triggeredBy }` |

There is no `refreshOAuthTokenForUser`. There is also no overload accepting `slotOrEmail`. So `cvault refresh 1` will land at Convex as `function not found`, return an error, and exit non-zero. The unit test for this command (`cli/tests/commands/refresh.test.ts`) does not catch it because the test stubs `client.action` and only inspects the args object — the action ref name and the backend's existence are never checked.

This is a hard regression against spec §7 ("`cvault refresh [slot]` — Triggers Convex `refreshOAuthToken` action manually") and against the team-lead's own handoff in `IMPLEMENTATION_NOTES.md` ("CLI agent's earlier requests (all addressed) — DONE under the name `requestRefresh`; please update the `// PENDING:` markers in `cli/src` to match"). The IMPLEMENTATION_NOTES instruction was not carried out.

**Fix:**

1. Replace the string-keyed proxy in `cli/src/commands/refresh.ts` with the typed reference:
   ```ts
   import { api } from '../../../convex/_generated/api'
   // ...
   await client.action(api.subscriptions.actions.requestRefresh, { subId })
   ```
2. Resolve `slotOrEmail` to a `subId` first (mirror what `cli/src/commands/remove.ts:resolveEmail` does, but resolve to `_id`). The spec says CLI accepts slot|email; the backend wants `subId` because action-level ownership re-verification is by id.
3. Update `cli/tests/commands/refresh.test.ts` to assert the ref is `api.subscriptions.actions.requestRefresh` and the arg is `{ subId }`. Add a scenario test that runs `runRefresh()` against `convex-test`'s in-process vault to catch this class of contract drift in CI.

**Blast radius:** the same string-keyed-proxy pattern is used in five other commands (`add`, `list`, `switch`, `sync`, `status`, `remove`). C2 covers `add`/`list`/`switch`/`sync`/`status`/`remove` more generally — they are NOT broken by name today (the strings happen to match the backend's exports), but they are one rename away from breaking the same way.

---

### C2 — Dashboard "Force Refresh" is a fake 250 ms timer

**File:** `frontend/src/routes/dashboard/index.tsx:60-77`

```ts
const handleForceRefresh = async ({ email }: { email: string }) => {
  setRefreshingByEmail((prev) => ({ ...prev, [email]: true }))
  try {
    // PENDING: team-lead to expose api.subscriptions.actions.refreshOAuthToken
    // as a public action. Until then, we surface a console message so the
    // user understands why the spinner is short-lived.
    console.warn(
      '[cvault] Force Refresh: api.subscriptions.actions.refreshOAuthToken is currently internal-only. Backend agent will expose a public wrapper soon.'
    )
    await new Promise((res) => setTimeout(res, 250))
  } finally { /* ... */ }
}
```

The backend shipped `api.subscriptions.actions.requestRefresh` (an `authenticatedAction` that re-verifies ownership and delegates to the internal refresh). The IMPLEMENTATION_NOTES "Frontend agent's earlier requests (all addressed)" section explicitly calls this out as DONE. The dashboard never updated to use it. The user clicking "Force Refresh" sees a 250 ms spinner and nothing happens server-side.

This is a regression against spec §8 (`Force Refresh` is one of the three per-card actions) and §10 (manual refresh is the user's escape hatch when the cron is slow). The unit test for `/dashboard` (`frontend/src/__tests__/routes/dashboard.test.tsx`) only asserts the button is wired to `onForceRefresh` — it does not assert the action is dispatched, so the suite stays green.

**Fix:**

```ts
const requestRefresh = useAction(api.subscriptions.actions.requestRefresh)
// ...
const handleForceRefresh = async ({ subId }: { subId: Id<'subscriptions'> }) => {
  setRefreshingBySubId((prev) => ({ ...prev, [subId]: true }))
  try { await requestRefresh({ subId }) }
  finally { /* clear */ }
}
```

Update `SubscriptionCardProps.onForceRefresh` to pass `subId` instead of `email` (the backend wants the id), and update the test to assert the Convex `useAction` mock is called with `{ subId }`.

---

## 3. Important findings (should fix; some flagged in security audit)

### I1 — `/cli/link` accepts arbitrary `redirect` URLs (open redirect → token exfil)

**File:** `frontend/src/routes/cli/link.tsx:33-38, 78`

`SearchSchema` accepts `redirect: z.string().url()`. Any URL passes — `https://attacker.example.com`, `http://localhost.attacker.example.com`, even `javascript:` (well, `z.string().url()` does reject `javascript:`, but `https://...` phishing is fully allowed). When a signed-in user opens `https://app.cvault.dev/cli/link?redirect=https://attacker.example.com&state=X`, the page auto-fetches a fresh Clerk sign-in token via `api.cli.actions.startLink({state: X})` and POSTs `{state: X, signInToken}` to the attacker's URL.

The CLI side correctly binds 127.0.0.1; the dashboard side completely undermines that. Token is single-use and 10-minute-TTL, but that's plenty of time for an attacker to redeem it via Clerk FAPI and complete a sign-in as the victim user.

This is the H1 finding from `docs/research/security-findings.md`. It is not in the v1 scope of the spec but it materially undermines spec §7 ("the CLI listener is bound 127.0.0.1") and spec §15 ("token never hits URL bar / referer (POST'd from dashboard to 127.0.0.1:<port>)").

**Fix:** Tighten `validateSearch` to require `redirect` to start with `http://127.0.0.1:` or `http://[::1]:` (and only those). Reject anything else with a clear error before any Convex call. Optional but worth it: add a one-click confirmation step ("send sign-in token to 127.0.0.1:54321?") so a stolen URL alone can't drive the POST.

```ts
const SearchSchema = z.object({
  redirect: z.string().refine(
    (s) => {
      try {
        const u = new URL(s)
        if (u.protocol !== 'http:') return false
        return u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost'
      } catch { return false }
    },
    { message: 'redirect must be an http://127.0.0.1:<port>/ URL' }
  ),
  state: z.string().min(8),
})
```

### I2 — `decrypt()` failure in `refreshOAuthToken` leaks the lease for 30s and emits no `refreshLog` row

**File:** `convex/subscriptions/actions.ts:219, 342`

`decrypt(sub.ciphertext, sub.nonce)` is called outside any try/catch in `refreshOAuthToken`. If the row is corrupt (key rotated, ciphertext/nonce mangled, GCM tag mismatch) the auth-tag check throws. `releaseRefreshLease` is never called and the lease lives until its 30-second TTL. No `refreshLog` row is inserted, so the user sees no `corrupt — re-add` signal. Spec §10 explicitly says this case should be logged as failure with a message like "creds corrupt — re-add".

`fetchUsageForSub` has the same pattern (line 342), with the lighter consequence that the cron silently masks every poll forever for a corrupt sub.

**Fix:** Wrap each `decrypt(...)` call in try/catch. On failure in `refreshOAuthToken`, run `releaseRefreshLease` and `refreshLog.insert` with `outcome:'failure', error: redactTokens('decrypt failed; subscription credentials corrupt — re-add')`. In `fetchUsageForSub`, just return null (next tick will retry — but emit a `console.error` so it's visible in Convex logs). This is a concrete bug, not a polish suggestion: the code today violates §10's explicit text.

### I3 — Cron fanout uses `Promise.all` instead of `Promise.allSettled`

**File:** `convex/subscriptions/crons.ts:33-40, 54-60`

```ts
await Promise.all(expiring.map((row) =>
  ctx.runAction(internal.subscriptions.actions.refreshOAuthToken, {...})
))
```

Per spec §10, "Anthropic refresh 5xx / network → Log `failure`; cron retries next tick" and "Anthropic usage 429 → Skip cycle, retry next 5m" — both are per-sub semantics. `Promise.all` rejects on the first throwing action, masking what actually happened to other subs and logging the cron run as a whole as failed. `refreshOAuthToken` itself catches its own Anthropic errors and self-logs (so this is mostly a problem when an action fails at the `decrypt`/`runMutation` layer per I2), but `fetchUsageForSub` returns silently on Anthropic error and is fine.

**Fix:** Switch both to `Promise.allSettled`. The per-action handlers already self-log via `refreshLog`; `allSettled` matches both spec semantics.

### I4 — Public mutations/actions skip `machineActivity` audit (audit feed is half-blind)

**Files:** `convex/subscriptions/mutations.ts` (softRemove, rename, upsert), `convex/subscriptions/actions.ts` (upsertFromPlaintext, requestRefresh), `convex/cli/actions.ts` (startLink, revokeSession), `convex/cli/httpSync.ts` (whole route).

Today only `pullForSwitch` records a `machineActivity` row. The schema enum already contains `'add'`, `'remove'`, `'refresh'` — these are unreachable because nobody emits them. The bulk `/api/cli/sync` HTTP route, which dumps every active sub's plaintext in one response, also writes nothing.

Spec §4 + §6 + §12 frame `machineActivity` as the audit trail. Spec §8 puts it on `/dashboard/audit`. Today the audit feed shows `pull` only — no record of when subs were added, removed, refreshed manually, when the CLI bulk-bootstrapped a fresh machine, or when a session was revoked.

**Fix:** Each authenticated public mutation/action should call `internal.machineActivity.mutations.record` for its action. The cleanest implementation is a small helper that the wrappers call after a successful handler return; the spec already nudges that direction. At minimum, wire each of the public functions above to `record` with the appropriate enum literal and pass the Clerk `sid` claim (same pattern `pullForSwitch` already uses on line 78-79).

For `/api/cli/sync` specifically: pass the request's IP (`request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()`) to `record` as `rawIp` so the bulk-pull also records audit + an ipHash. This also solves I5.

### I5 — `machineActivity.record` accepts `rawIp` but no caller passes it

**File:** `convex/machineActivity/mutations.ts:45`

The mutation signature includes `rawIp: v.optional(v.string())` which it SHA-256-prefixes into `ipHash`. No caller provides it: `pullForSwitch` is over WebSocket and has no HTTP request handle, and the only caller that does have a `Request` (`cliSyncHandler`) doesn't record activity at all (see I4). Result: every audit row in production will have `ipHash: undefined`. The `/dashboard/audit` "ip" column is dead.

**Fix:** Coupled with I4 — once `cliSyncHandler` and any future HTTP-action mutations record activity with the request IP, this becomes meaningful. Also security-audit M5.

### I6 — Pervasive string-keyed Convex action refs in CLI source

**Files:** `cli/src/commands/{add,list,refresh,remove,status,switch,sync}.ts`

Every CLI command builds an action ref like:
```ts
const ref = {
  _name: 'subscriptions/actions:pullForSwitch',
} as unknown as Parameters<typeof client.action>[0]
await client.action(ref, args as never)
```

This pattern violates `rules/type-safety.md`'s "no `as unknown as` to silence the compiler" because it is exactly that. It also makes C1 not just possible but predictable: any rename on the backend silently breaks the CLI, and no test catches it because the CLI tests stub `client.action` to a Vitest fn.

The infrastructure to do this typed already exists: `cli/src/convex/vaultClient.ts` accepts `FunctionReference<'query'|'mutation'|'action'>`, and the Convex repo's generated `convex/_generated/api.d.ts` is a path-aliasable peer (the CLI's `tsconfig.json` already imports `Id` types from there in ad-hoc places). The team-lead notes in `IMPLEMENTATION_NOTES.md` explicitly say "swap to `api.subscriptions.actions.upsertFromPlaintext` once the backend exposes it" — the backend has, and the CLI hasn't.

**Fix:** Add a `tsconfig.json` path alias `"@convex": ["../convex/_generated/api"]` (or similar) on the CLI's tsconfig, import `api`, and replace every string-keyed ref in `cli/src/commands/*.ts` with the typed `api.<domain>.<file>.<symbol>` reference. This single change retires every `// PENDING:` marker in the CLI source, eliminates ~10 `as unknown as`/`as never` casts, and gives `bunx tsc --noEmit` real visibility into wire-level mismatches.

### I7 — `pullForSwitch` proactive refresh failure crashes the whole switch

**File:** `convex/subscriptions/actions.ts:60-65`

```ts
if (sub.expiresAt < now + REFRESH_PROACTIVE_MS) {
  await ctx.runAction(internal.subscriptions.actions.refreshOAuthToken, {...})
}
// ... continues to decrypt + return
```

If Anthropic 5xx during the proactive refresh, `refreshOAuthToken` self-logs failure and returns null. `pullForSwitch` continues, decrypts the (still valid for ~5 min) old plaintext, and returns it. Good.

But if Anthropic 401-with-`invalid_grant`, `refreshOAuthToken` calls `markReloginRequired` which clamps `refreshExpiresAt = now`. `pullForSwitch` then re-reads the sub and decrypts — but the access token is still valid for ~5 min, so the user gets a working credential plus an `⚠ relogin` flag on the next `cvault list`. Acceptable.

If `decrypt()` throws (I2 case) in the proactive refresh, the action rejects, `pullForSwitch` rejects, the CLI's `runSwitch` catches it, but only `isNetworkError(err)` triggers the offline fallback (`switch.ts:81-93`). A "decrypt failed" or "lease lost" or any other non-network ConvexError will throw and the user gets an error rather than the local fallback. This is a degradation gap from spec §10.

**Fix:** In the CLI `runSwitch`, broaden the offline fallback to also catch "decrypt failed" / "creds corrupt" with a clearer message: "vault credentials corrupt for {email}; falling back to local cache, please run `cvault add` to refresh."

### I8 — Clerk error bodies are echoed to the dashboard caller

**Files:** `convex/cli/actions.ts:34-38, 56-60`

```ts
throw new ConvexError({
  code: 'CLERK_BACKEND_ERROR',
  message: `Clerk sign-in token request failed: ${result.status.toString()}: ${result.body.slice(0, 200)}`,
})
```

Clerk Backend API error bodies can include user emails, lockout reasons, or account-takeover suspicions. These are surfaced through Convex to the dashboard JS, which logs them via `console.error('[cvault] CLI link exchange failed', e)`. Some of those messages are exactly what the user-under-attack should not see (e.g., "user is locked due to suspicious activity from IP X") — they tip them off that the lockout is fresh.

**Fix:** Log the full body server-side via `console.error` (Convex log dashboard, not client) and throw a generic `Clerk Backend API ${status}` message. Or filter the body to a small allowlist of safe fields.

---

## 4. Suggestions (nice to have)

### S1 — `users/actions.ts:14` uses `v.any() as Validator<UserJSON>`

This is pre-existing Blueprint code, not cvault, but it's in the audited tree and violates the project's `rules/type-safety.md`. Worth defining a strict `v.object({...})` validator for the subset of `UserJSON` the handler actually reads. Same for `organizations/actions.ts` and `organizationMembers/actions.ts`.

### S2 — `getIdentity()` runtime narrowing then `as UserIdentity` cast

`convex/utils/auth.ts:50-75`. The runtime checks ARE thorough (verifies `subject`, `issuer`, `tokenIdentifier` are strings); the final `id as UserIdentity` cast is fine. But it makes the failure mode silent if a future refactor accidentally passes a non-augmented ctx. Consider returning a freshly constructed `{ subject, issuer, tokenIdentifier, ...optionals }` rather than re-asserting the same reference. This is a minor polish; keeping the cast is acceptable per the deviation note.

The runtime helper itself is a justified deviation — Convex's `QueryBuilder<DataModel,'public'>` cast does erase the `identity` augmentation, and writing custom-builder generic math that intersects properly with Convex internals is a significant detour. The runtime helper is the right v1 trade. Document the chosen abstraction in spec §16 if/when a v2 spec is written.

### S3 — Anthropic refresh wire is mock-tested only; no scenario test exists

Spec §11 calls for `__scenarios__/refreshCycle.scenario.ts` gated on `VAULT_TEST_REFRESH_TOKEN`. The convex test file says "deferred to v2" in IMPLEMENTATION_NOTES. The directory `convex/__tests__/scenario/` exists but is empty.

Without a live wire test, an undocumented Anthropic header change (or a URL change, which spec §14 flags as a risk) will silently break refresh until production traffic surfaces it. v1 is acceptable to ship without it, but a one-test scaffold that runs only when `VAULT_TEST_REFRESH_TOKEN` is set would be a 30-minute investment with permanent ROI. Add a placeholder file with a `it.skipIf(!env.VAULT_TEST_REFRESH_TOKEN)` so the scaffold exists.

### S4 — Redaction regex prefix is too narrow

`convex/subscriptions/redact.ts:14`: `/sk-ant-[a-z]+\d+-[A-Za-z0-9_-]{20,}/g`. If Anthropic ever issues uppercase prefixes (`sk-ant-API01-...`), redaction silently fails. Loosening `[a-z]+` to `[A-Za-z]+` is a one-character forward-compat fix. Adding a property test that random token-shaped strings always redact would lock this in. (Security-audit L4.)

### S5 — `requestRefresh` action has no per-user rate limit

Spec §12 defers per-user rate limiting to v2. Acceptable. But `requestRefresh` is the single most attacker-attractive endpoint — it forces an Anthropic refresh of ANY of the caller's own subs, which is cheap for the caller and costs Anthropic a refresh slot per request. Even a 10/minute per-user cap via convex-helpers' rate limiter would be appropriate before public dashboard launch.

Also relevant for `/api/cli/sync`: bulk-pull deserves stronger protection than the rest of the surface even before generic rate limiting lands.

### S6 — Pull-on-use double-fetch in `pullForSwitch`

`convex/subscriptions/actions.ts:50-71`: a `runQuery` to fetch the sub, then optional `runAction` to refresh, then a second `runQuery` to re-read the fresh ciphertext. Acceptable for v1 per the team-lead's notes. v2: consider returning the post-commit ciphertext from `commitRefreshedTokens` and threading it through to avoid the second read. Low ROI; flag only.

### S7 — README is gigantic (45 KB) for an unreleased v0.1.0

Pre-existing observation, not a code issue. The README is comprehensive but currently 45 KB of largely speculative usage instructions. Consider trimming to a quickstart + linking the spec for full detail, until v0.1 actually ships and the docs prove correct against shipped behavior. Skip this entirely if scope-creep risk; it's purely a polish.

---

## 5. Spec deviation evaluation (the 5 builders flagged)

### D1 — Anthropic 400 invalid_grant → reloginRequired (in addition to 401)

**File:** `convex/subscriptions/actions.ts:251-264`. **Justified.** The OAuth research brief documents that providers commonly return 400 with `invalid_grant`. Spec §10 mentioned only 401. The implementation correctly:
- Treats 400 OR 401 with parsed JSON `error: 'invalid_grant'` → reloginRequired.
- Treats bare 401 (non-JSON body) → reloginRequired conservatively.
- Treats bare 400 (non-JSON body) → ordinary failure.

This is a strict superset of spec §10, no invariant broken. Keep. Worth a one-line spec amendment in the next revision so the spec catches up.

### D2 — `getIdentity(ctx)` runtime helper

Justified — see S2. The alternative (custom-builder generic math intersecting with Convex's `QueryBuilder<DataModel,'public'>` typing) is materially harder than the runtime check and the wrapper still attaches the augmented identity at runtime. The deviation note in IMPLEMENTATION_NOTES is honest. Keep. Tests cover it (`utils/auth.test.ts`).

### D3 — `upsertFromPlaintext` is a public action (not mutation)

Justified — `node:crypto` is unavailable in the V8 mutation runtime, and the spec invariant "CLI never holds the master key" is preserved by encrypting server-side and delegating to the internal `upsertEncrypted` mutation. The whole story is covered by tests (`upsertFromPlaintext.test.ts`). Keep.

### D4 — Public `requestRefresh` action wrapping internal `refreshOAuthToken`

Justified, and necessary. The spec was ambiguous about which action is the public-callable; the choice (separate public wrapper that re-verifies ownership via `getSubscriptionByIdForActor`, then delegates) is the right one — it cleanly isolates cron-triggered runs from user-triggered runs. Tests cover ownership rejection + happy path (`refresh.test.ts`).

The only loose end: the CLI doesn't actually call this yet (C1) and the dashboard doesn't either (C2). The deviation itself is sound; the consumers are out of date. Keep the deviation, fix C1 and C2.

### D5 — Vitest 4 `projects` config (3 projects)

Justified — Vitest 4 deprecated `environmentMatchGlobs`, and the multi-runtime split (convex-edge / convex-node / frontend) is a cleaner way to structure the test environments anyway. Keep. The CLI is correctly excluded since it uses Bun globals and runs via its own `package.json` script.

---

## 6. Section-by-section spec adherence

### §3 Architecture: CLEAN
All four source-of-truth lines match: Convex tables, Convex functions, HTTP `/api/cli/sync`, crons (10m + 5m). Trust model and stack align with spec. The CLI shells to `claude-swap` exclusively for Keychain access (verified: no `keytar`/`node-keychain` deps). Pull-on-use semantics in `cvault switch` match spec.

### §4 Schema: CLEAN
All three new tables (`subscriptions`, `refreshLog`, `machineActivity`) match the spec exactly: field names, types, indexes, and validators.

### §5 Functions: MOSTLY CLEAN; gap C1
The function surface is implemented. `requestRefresh` (D4) covers the spec's "public-callable refresh" intent. `upsertFromPlaintext` (D3) covers `upsert({email, plaintextBlob, slot?})`. The only spec-vs-impl mismatch on the function surface is C1's `cvault refresh` mis-named call. All cron-scheduled functions are `internalAction` per spec.

### §6 Encryption envelope: CLEAN
All invariants satisfied: 32-byte AES-256-GCM key from `VAULT_AES_KEY` env var, fresh 12-byte nonce per write, auth-tag verification, plaintext only inside Node actions, no plaintext in `machineActivity` or `refreshLog`. Token regex applied. `cli/src/render/redact.ts` matches the convex regex (single-source). Tests cover roundtrip + tampered-ciphertext + tampered-nonce + missing-key + wrong-key-length.

### §7 CLI: BROKEN ON REFRESH; rest works
- `login`: implemented end-to-end with browser-assisted Clerk sign-in, callback server bound 127.0.0.1, timing-safe state comparison, 2-min hard timeout.
- `add`: implemented; uses `upsertFromPlaintext` action correctly via string-keyed ref (unit tests assert arg shape).
- `list`, `switch`, `remove`, `status`, `sync`: implemented; all use string-keyed refs (I6) but the names happen to match backend exports.
- `refresh`: BROKEN (C1). Bad name, bad args.
- Distribution: `bun build --compile` works (verified — clean 59 MB binary). Homebrew tap formula directory exists. Codesign step in `release-cli.yml` per CLI agent's note.
- `~/.vault/` perms: dir 0700, files 0600, atomic write via temp-rename, perms-checked on read. Verified in `cli/src/paths.ts`.

### §8 Dashboard: BROKEN ON FORCE REFRESH; rest works
- `/dashboard`: sub list cards, usage bars, expiry, last refresh, relogin badge — all wired. Force Refresh BROKEN (C2). Rename + Remove work.
- `/dashboard/audit`: merged feed with subEmail/session/outcome filters. Wired against `refreshLog.queries.recentForUser` + `machineActivity.queries.recentForUser`. Rendering correct.
- `/dashboard/machines`: distinct sessions list with revoke action. Wired against `cli.actions.revokeSession`. Works.
- `/dashboard/settings`: v2 placeholder cards (rotate key, export backup, notifications) + help links. Matches spec §8 deferred-feature placeholders.

### §9 Refresh race protection: CLEAN
Lease mechanism implemented as spec, with strong invariants:
- `tryAcquireRefreshLease` is a single Convex mutation (atomic by definition).
- TTL check correct.
- `releaseRefreshLease` no-ops on holder mismatch (defensive).
- `commitRefreshedTokens` throws `LEASE_LOST` on holder mismatch.
- Loser path sleeps 1s, re-checks, returns null.
- 30s lease TTL + auto-release.
- Holder token is `randomBytes(16).toString('hex')`.

Tests cover all five behaviors.

### §10 Error handling: MOSTLY CLEAN; gaps I2 + I3
- 400/401 invalid_grant → reloginRequired: covered (D1).
- 5xx / network → failure with lease released: covered.
- Lease loss → sleep 1s, re-query, abort: covered.
- 429 usage → silent skip: covered.
- **Decrypt failure → throw, log error, surface as "creds corrupt": NOT covered** (I2 — gap).
- Action timeout → 30s lease TTL: implicit (Convex action timeouts handle this).
- Cron per-sub failure → masking via Promise.all: gap (I3).

### §11 Testing: ADEQUATE; gap on scenario tests
- Convex backend: 70 tests across 13 files, well-distributed across spec invariants.
- CLI: 117 tests across 18 files; coverage is broad but stubs out the typed API (see C1 / I6 — contract drift slips through).
- Frontend: 52 tests across 11 files; `useQuery` and `useMutation` are stubbed.
- Coverage targets (90% backend / 80% CLI / 70% frontend): not measured in the build report. Should add a coverage step.
- Scenario test (`__scenarios__/refreshCycle.scenario.ts` per spec §11): NOT IMPLEMENTED. Directory `convex/__tests__/scenario/` is empty (S3).

### §12 Security: CLEAN at the layer audited; gap I1 in frontend
The Convex backend security posture matches `docs/research/security-findings.md`'s clean assessment. Plaintext refresh tokens never persist in `refreshLog`/`machineActivity`. AES-GCM properly used. User isolation enforced on every read/write. Cron jobs are auth-isolated. CLI session JSON mode 0600 + atomic write. Localhost callback bound to 127.0.0.1.

The single security regression is the `/cli/link` redirect host validation (I1).

### §13 Deployment: NOT FULLY VERIFIABLE
- Convex env vars (`VAULT_AES_KEY`, `CLERK_*`): documented but actual prod state can't be checked from code alone.
- CI workflow `.github/workflows/release-cli.yml`: not read in this review (CLI agent's notes confirm codesign + matrix build are wired).
- Frontend Cloudflare Pages: pre-existing Blueprint workflow, not cvault-specific.
- Spec §13 references "PyPI publish" which is stale (the CLI pivoted to Bun on 2026-05-02 per spec §15). The spec § needs updating.

### §14 Open items: APPROPRIATE
The deferred items (live scenario test, watch daemon, encrypted backup, refresh-failure notifications, key rotation, rate limiting, multi-org sharing) are all reasonable v2 punts.

The two items I'd reconsider for v1: rate limiting on `requestRefresh` and `/api/cli/sync` (S5), and a one-test scaffold for the scenario test even if gated (S3).

---

## 7. What's NOT broken (kudos)

Crediting work the team got right:

- **Encryption envelope** is a textbook AES-GCM implementation. Key length asserted, fresh nonce per write, auth-tag verified on decrypt, server-side-only encryption so the CLI never holds the master key. Proper test coverage on tampering and key validation.
- **Refresh-race protection** is correctly implemented with all spec invariants tested. The lease + holder-token + TTL pattern is exactly what spec §9 calls for.
- **`pullForSwitch` ownership scoping** is right. It uses `getSubscriptionForActor` which scopes by externalId, not by raw subId. The same `requestRefresh` re-verifies via `getSubscriptionByIdForActor`. Cross-user isolation tests exist and pass.
- **The `getIdentity()` deviation** is a clean engineering trade-off — runtime narrowing is honestly cheaper than fighting Convex's generic types, and the helper makes the intent explicit at every call site.
- **CLI binary builds cleanly** via Bun-compile; the macOS codesign workaround in `release-cli.yml` shows attention to actual user-facing surfaces.
- **Cursor-pointer base layer** was correctly added per the global UI rule (`frontend/src/styles.css:133-174`). The team-lead picked this up from the frontend agent's handoff note.
- **The token-redaction regex is single-source** between `convex/subscriptions/redact.ts` and `cli/src/render/redact.ts` (verbatim copy with the same comment). Drift risk is low.
- **The team-lead's IMPLEMENTATION_NOTES is honest.** The 5 deviations are documented, the deferred items are listed, and the gap items it surfaces are real (it explicitly calls out the un-updated CLI markers — C1 was, in fact, already known but not fixed).

---

## 8. Recommendation

**REQUEST CHANGES.** Two critical contracts (C1 + C2) are broken; one high-severity security finding (I1) materially undermines the CLI auth flow's stated invariant. Each of these is small to fix (≤30 LOC each) but they cannot ship as v1.

Required before v1:
- C1: wire `cvault refresh` to `api.subscriptions.actions.requestRefresh` with `{subId}` args. Update test to assert the typed ref.
- C2: wire dashboard "Force Refresh" to `useAction(api.subscriptions.actions.requestRefresh)` with `{subId}`. Update test to assert dispatch.
- I1: tighten `/cli/link` `redirect` to localhost-only.
- I6: replace the string-keyed Convex refs in CLI with typed `api` references — this is what would have caught C1 in CI. Add a path alias on `cli/tsconfig.json` so the CLI imports `convex/_generated/api`.

Strongly recommended before v1:
- I2: try/catch decrypt + log corrupt-cred failure.
- I3: switch crons to `Promise.allSettled`.
- I4: record `machineActivity` from the missing public mutations/actions and the `/api/cli/sync` HTTP route.

Acceptable to defer to v1.1:
- I5 (becomes a no-op once I4 lands).
- I7, I8.
- All S* items.

Once C1, C2, I1, and I6 are fixed and tested, the project meets the spec's v1 bar.

---

## 9. File map (everything I read for this review)

For the next reviewer, here is the full list of files I read so the audit trail is reproducible:

- Spec: `/Users/saadings/Desktop/cvault/docs/superpowers/specs/2026-05-02-cvault-design.md`
- Implementation notes: `/Users/saadings/Desktop/cvault/IMPLEMENTATION_NOTES.md`
- Security audit: `/Users/saadings/Desktop/cvault/docs/research/security-findings.md`
- Scenario plan: `/Users/saadings/Desktop/cvault/docs/research/scenario-tests-plan.md`
- Anthropic OAuth refresh: `/Users/saadings/Desktop/cvault/docs/research/anthropic-oauth-refresh.md`
- Convex backend (entire `/Users/saadings/Desktop/cvault/convex/` tree, 30+ files including all `*.test.ts`)
- CLI (entire `/Users/saadings/Desktop/cvault/cli/src/` and `/Users/saadings/Desktop/cvault/cli/tests/` trees)
- Frontend routes + components: `/Users/saadings/Desktop/cvault/frontend/src/routes/{__root.tsx,index.tsx,dashboard.tsx,dashboard/{index,audit,machines,settings}.tsx,cli/link.tsx}`, all `dashboard/*.tsx` components, `frontend/src/styles.css`, all `frontend/src/__tests__/` files
- Configs: `package.json`, `cli/package.json`, `vitest.config.ts`, `eslint.config.ts`, `.gitignore`, `.env.local`
