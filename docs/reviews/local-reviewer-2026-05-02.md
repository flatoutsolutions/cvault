# cvault — Local Reviewer Report

**Date:** 2026-05-02
**Reviewer:** Claude Opus 4.7 (local-reviewer agent)
**Scope:** Full repo review at `/Users/saadings/Desktop/cvault/` after parallel-builder phase
**Verification baselines confirmed:** yes (see §Verification)

---

## Verification (executed)

All verification commands run from `/Users/saadings/Desktop/cvault/`.

| Gate | Command | Result |
|---|---|---|
| Backend + frontend tests | `yarn test` | **PASS** — 122 tests across 23 files (2.0 s) |
| CLI tests | `cd cli && bunx --bun vitest run` | **PASS** — 117 tests across 18 files (374 ms) |
| Root lint | `yarn lint:check` | **PASS** — clean (no output) |
| Frontend typecheck | `npx tsc --noEmit -p tsconfig.app.json` | **PASS** — clean (no output) |
| Convex typecheck | `npx convex dev --once --typecheck enable` | **PASS** — "Convex functions ready! (4.79 s)" |
| CLI typecheck | `cd cli && bunx tsc --noEmit` | **PASS** — clean |
| Frontend build | `yarn build` | **PASS** — TanStack Start prerender succeeded |
| Format check | `yarn format:check` | **FAIL** — 95 files have prettier-style issues (Low) |

Tests + typechecks + lint match the builder agents' claims. The only verification miss is a missing `yarn format:fix` pass before the review window — see L8.

---

## Summary

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 4 |
| Medium | 7 |
| Low | 8 |
| Info | 5 |

The build is structurally sound: encryption envelope is correct, refresh-race
lease protocol holds, user isolation is enforced via authenticated wrappers
+ `byUser*` indexes, token redaction works for the documented shapes, and
the CLI's localhost callback binds 127.0.0.1 with constant-time state
comparison. Test coverage is broad (240+ tests across 41 files).

The single Critical issue is a **cross-tenant Clerk session-revocation
hole** in `cli.actions.revokeSession` that the read-only security audit
in `docs/research/security-findings.md` missed. Combined with H1 (open
redirect on `/cli/link`) from that same audit and three other High-severity
items, the build is not yet ready for production use, but everything is
fixable in <1 day of focused work.

---

## Findings

### Critical (must fix before any deployment, even dev-shared)

#### C1 — `cli.actions.revokeSession` is a cross-tenant authorization bypass

**File:** `convex/cli/actions.ts:48-64`

```ts
export const revokeSession = authenticatedAction({
  args: { clerkSessionId: v.string() },
  ...
  handler: async (ctx, { clerkSessionId }) => {
    void getIdentity(ctx)                 // only checks "is anyone signed in?"
    const result = await revokeClerkSession(clerkSessionId)
    ...
  },
})
```

The action is called as `api.cli.actions.revokeSession` from
`/dashboard/machines`. It accepts an arbitrary `clerkSessionId` and revokes
it via the Clerk Backend API. The **only** check is that the caller is
authenticated to *some* Clerk session. There is no check that the session
being revoked belongs to the caller.

Attack: Alice (any signed-in user) calls `api.cli.actions.revokeSession({ clerkSessionId: "<bob_session_id>" })`. The action calls Clerk Backend API with the deployment's `CLERK_SECRET_KEY` and revokes Bob's session. Bob is logged out everywhere.

Clerk session IDs are not designed to be unguessable secrets — they appear in some logs, JWT `sid` claims, and dashboards. Even without knowing other users' sessions, this allows lateral movement from a compromised account.

The test at `convex/cli/actions.test.ts:111-142` confirms the missing check: nothing in the test verifies ownership; the action accepts any session id.

**Fix:** Before calling `revokeClerkSession`, verify the session belongs to the caller by querying `machineActivity` with the `byUserAndSessionAndAt` index for the current user's `userId + clerkSessionId`. If no rows match, throw `ConvexError({ code: 'NOT_FOUND', message: 'Session not found or not owned by current user' })`. Add a regression test:

```ts
it('rejects revoke when the caller does not own the session', async () => {
  // Alice tries to revoke a session that has only ever been used by Bob
  const t = vault()
  await seedUser(t, TEST_IDENTITY)
  await seedUser(t, SECOND_IDENTITY)
  // Bob has activity for sess_bob_xyz
  await t.run(async (ctx) => {
    await ctx.db.insert('machineActivity', {
      userId: bobId, clerkSessionId: 'sess_bob_xyz', action: 'pull',
      at: Date.now(),
    })
  })
  await expect(
    t.withIdentity(TEST_IDENTITY).action(api.cli.actions.revokeSession, {
      clerkSessionId: 'sess_bob_xyz',
    })
  ).rejects.toThrow(/not found|not owned/i)
})
```

**Why it matters:** This is a true cross-tenant authz hole. The deployment's `CLERK_SECRET_KEY` is acting as a shared confused-deputy in service of any signed-in user, against the entire user base.

---

### High (should fix before merging)

#### H1 — Open-redirect on `/cli/link` lets any URL receive the freshly-minted Clerk sign-in token

**File:** `frontend/src/routes/cli/link.tsx:33-38, 78-87`

The `/cli/link` route validates `redirect` only as `z.string().url()`. After
`startLink` mints a Clerk sign-in token, the page POSTs `{state, signInToken}`
to whatever URL is in `redirect`. A phishing link
`/cli/link?redirect=https://attacker.example.com/&state=<8+chars>` opened by
a signed-in user lets the attacker capture a single-use sign-in token bound
to that user_id — sufficient for the attacker to complete a Clerk sign-in
as that user.

The CLI side is fine (it binds `127.0.0.1` only). The dashboard side does
not enforce the inverse constraint.

**Fix:** Restrict `redirect` to `http://127.0.0.1:<port>/...` or
`http://[::1]:<port>/...` in the Zod validator:

```ts
const SearchSchema = z.object({
  redirect: z.string().url().refine((url) => {
    try {
      const u = new URL(url)
      return u.protocol === 'http:'
        && (u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost')
    } catch { return false }
  }, 'redirect must be http://127.0.0.1:<port>/...'),
  state: z.string().min(8),
})
```

Optionally add a click-to-confirm step ("send token to 127.0.0.1:54321?")
so a stolen URL alone can't drive the POST.

**Source:** Found in `docs/research/security-findings.md` §H1; reproduced here because it is High severity and the current code is unfixed.

#### H2 — Dashboard "Force Refresh" button is wired to a `console.warn` no-op

**File:** `frontend/src/routes/dashboard/index.tsx:60-77`

The button is the user's primary recovery mechanism when Anthropic refresh fails. The handler:

```ts
const handleForceRefresh = async ({ email }) => {
  setRefreshingByEmail((prev) => ({ ...prev, [email]: true }))
  try {
    console.warn('[cvault] Force Refresh: api.subscriptions.actions.refreshOAuthToken is currently internal-only. ...')
    await new Promise((res) => setTimeout(res, 250))
  } finally { ... }
}
```

The backend has shipped `api.subscriptions.actions.requestRefresh({ subId })` (per IMPLEMENTATION_NOTES.md §"Frontend agent's earlier requests" #3) but the frontend was never updated to call it. The button is visibly active (looks clickable, shows a spinner) but does nothing — a silent regression.

**Fix:** 

```ts
const requestRefresh = useAction(api.subscriptions.actions.requestRefresh)
// ...
const handleForceRefresh = async ({ email }: { email: string }) => {
  const sub = subs.find((s) => s.email === email)
  if (!sub) return
  setRefreshingByEmail((prev) => ({ ...prev, [email]: true }))
  try {
    await requestRefresh({ subId: sub._id })
  } catch (e) {
    console.error('[cvault] Force Refresh failed', e)
    // surface error to the user — currently swallowed
  } finally {
    setRefreshingByEmail((prev) => { const next = { ...prev }; delete next[email]; return next })
  }
}
```

Also add an error UI state (currently no error rendering on the SubscriptionCard).

**Why it matters:** Spec §8 lists Force Refresh as the single per-card action in addition to Rename/Remove. Shipping a no-op button is worse than no button — it lies about state. Plus: the IMPLEMENTATION_NOTES.md handoff explicitly said this should be wired up.

#### H3 — `pullForSwitch` continues to return stale plaintext after a failed proactive refresh

**File:** `convex/subscriptions/actions.ts:58-65, 88-95`

```ts
if (sub.expiresAt < now + REFRESH_PROACTIVE_MS) {
  await ctx.runAction(internal.subscriptions.actions.refreshOAuthToken, {
    subId: sub._id,
    triggeredBy: 'onUse',
  })
}
// Re-read after potential refresh to get the fresh ciphertext.
const fresh = await ctx.runQuery(internal.subscriptions.internalReads.getSubscriptionByIdForActor, ...)
```

`refreshOAuthToken` swallows network/5xx failures (logs `outcome: 'failure'` and returns null). `pullForSwitch` then re-reads the *unchanged* sub row, decrypts, and returns the **stale, already-expired** plaintext to the CLI. The CLI imports it into Keychain and `claude-swap --switch-to`s — at which point Claude Code uses an expired token and the user gets opaque "401 from Anthropic" errors with no mention of the cvault layer.

**Fix:** After the refresh attempt, re-check `fresh.expiresAt` against `now + REFRESH_PROACTIVE_MS`. If it's still in the past (refresh definitively did not advance it), throw a `ConvexError({ code: 'REFRESH_FAILED', message: 'Token refresh failed; check /dashboard/audit and try again' })`. Spec §10 says "creds corrupt — re-add", but for transient failure the message should differ.

```ts
if (fresh.expiresAt < Date.now()) {
  throw new ConvexError({
    code: 'REFRESH_FAILED',
    message: 'Anthropic OAuth refresh failed and stored token is expired. See /dashboard/audit.',
  })
}
```

**Why it matters:** Pull-on-use is the primary CLI flow per spec §7. Silent stale-token return makes the failure mode invisible to the user and untrackable from the CLI.

#### H4 — `decrypt()` in actions throws unwrapped, leaking the lease for the full 30s TTL on auth-tag mismatch

**File:** `convex/subscriptions/actions.ts:219, 342`

```ts
// refreshOAuthToken
const plaintext = decrypt(sub.ciphertext, sub.nonce)  // throws → handler exits with thrown error
// ... releaseRefreshLease never runs
```

GCM auth-tag mismatch (corrupt ciphertext, key rotated, nonce mangled)
throws synchronously, the surrounding action handler exits with the
exception, and `releaseRefreshLease` is never called. The lease stays
held until the 30s TTL expires. **No `refreshLog` row is inserted**, so
the dashboard / CLI never learn that the credentials are corrupt and
need to be re-added.

In `fetchUsageForSub`, the same throw means the cron run fails and the
next 5-minute tick is skipped silently.

**Fix:** Wrap each decrypt in try/catch:

```ts
let plaintext: string
try {
  plaintext = decrypt(sub.ciphertext, sub.nonce)
} catch (err) {
  await ctx.runMutation(internal.subscriptions.mutations.markReloginRequired, {
    subId, holderToken,
  })
  await ctx.runMutation(internal.refreshLog.mutations.insert, {
    userId: sub.userId, subscriptionId: subId, triggeredBy,
    outcome: 'failure',
    error: redactTokens(`decrypt failed: ${err instanceof Error ? err.message : String(err)}`),
    at: Date.now(),
  })
  return null
}
```

Per spec §10 "Decrypt failure (GCM auth tag) → Throw, log error w/ subId; surface as 'creds corrupt — re-add'". The current code throws but doesn't log.

**Source:** `docs/research/security-findings.md` §M1; raised to High here because the lease-leak interacts with H3 (subsequent `pullForSwitch` callers will spin on the loser path for 30s every time).

---

### Medium (should fix before next milestone)

#### M1 — `findExpiringSubs` calls `Date.now()` inside an `internalQuery`

**File:** `convex/subscriptions/internalReads.ts:91`

```ts
export const findExpiringSubs = internalQuery({
  ...
  handler: async (ctx, { withinMs }) => {
    const cutoff = Date.now() + withinMs       // ⚠ non-deterministic in a query
    ...
  },
})
```

Convex queries are deterministic and cacheable — the engine assumes the same
`(handler, args)` pair returns the same result for cache invalidation
purposes. `Date.now()` violates this assumption silently. While crons
typically don't hit the cache, any future call site that subscribes to
this query (e.g., a debug dashboard) would see stale data.

**Fix:** Compute the cutoff in the action and pass it in:

```ts
// internalReads.ts
export const findExpiringSubs = internalQuery({
  args: { cutoff: v.number() },
  ...
  handler: async (ctx, { cutoff }) => {
    const rows = await ctx.db.query('subscriptions')
      .withIndex('byExpiry', (q) => q.lt('expiresAt', cutoff))
      .collect()
    return rows.filter((r) => r.removedAt === undefined).map((r) => ({ subId: r._id }))
  },
})

// crons.ts
const cutoff = Date.now() + REFRESH_WINDOW_MS
const expiring = await ctx.runQuery(internal.subscriptions.internalReads.findExpiringSubs, {
  cutoff,
})
```

**Why it matters:** Convex's `convex:convex-essentials` skill explicitly prohibits `Date.now()` in queries. This is a latent correctness bug that won't manifest until query results get cached.

#### M2 — `Promise.all` over per-sub fanout in crons rejects the whole run on one failure

**File:** `convex/subscriptions/crons.ts:33-40, 54-60`

```ts
await Promise.all(
  expiring.map((row) =>
    ctx.runAction(internal.subscriptions.actions.refreshOAuthToken, ...)
  )
)
```

A single sub whose decrypt throws (H4) or whose Anthropic call throws an
unhandled exception will cause the whole `refreshExpiringTokens` cron
run to reject. Convex surfaces this as a cron failure in the dashboard
but masks per-sub root-cause analysis. For `pollUsage`, the spec §10
explicitly says "skip cycle silently" per-sub, which `Promise.all` does
not do.

**Fix:** `Promise.allSettled` instead of `Promise.all`. The per-action
handlers already self-log via `refreshLog`; usage failures are silent
per spec.

**Source:** `security-findings.md` §M2.

#### M3 — `/api/cli/sync` returns plaintext for every sub with no rate limit and no audit row

**File:** `convex/cli/httpSync.ts`, `convex/cli/syncAction.ts`

The endpoint returns the plaintext for every active sub in one call.
- No `machineActivity` row written (`pullForSwitch` writes one for each per-sub pull, but bulk-sync writes none).
- No rate limit (a leaked Clerk JWT yields the entire credential dump in one request).
- No idempotency / per-call counter.

**Fix:** 
- Insert a `machineActivity` row with `action: 'pull'` and a separate marker (or new literal `'sync'`) for the bulk-pull.
- Add convex-helpers rate limiting (1 bulk pull per machine per minute) once the v2 rate-limit work lands.
- Pass `request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()` as `rawIp` so the audit row at least gets an IP hash.

**Source:** `security-findings.md` §M3.

#### M4 — Most public mutations and actions don't write audit rows

**File:** `convex/subscriptions/actions.ts`, `convex/subscriptions/mutations.ts`, `convex/cli/actions.ts`

Per spec §4, the `machineActivity.action` enum includes `add`, `remove`,
`refresh`, `switch`, `pull`. Today only `pullForSwitch` records an
activity row. `softRemove`, `rename`, `upsertFromPlaintext`,
`requestRefresh`, `revokeSession`, and `/api/cli/sync` do not. The
audit feed at `/dashboard/audit` is missing entire categories of events.

**Fix:** Have each authenticated public mutation/action emit a
`machineActivity.record` call. Centralise via a helper or move into
the `authenticatedMutation` / `authenticatedAction` wrappers with a
metadata arg.

**Source:** `security-findings.md` §M4.

#### M5 — `machineActivity` accepts `rawIp` but no caller ever passes it

**File:** `convex/machineActivity/mutations.ts:38-60` and call sites

The mutation hashes `rawIp` to a SHA-256 prefix and stores it. But:
- `pullForSwitch` is invoked over WebSocket; no access to the raw HTTP request.
- `cliSyncHandler` has access to `request` but doesn't read forwarded-for.

Result: every audit row's `ipHash` is `undefined`. The
`/dashboard/machines` "last ip" column always shows `—`.

**Fix:** Either drop the `rawIp` arg + `ipHash` field as YAGNI, or wire
`cliSyncHandler` to pass `x-forwarded-for`. Don't ship dead code that
suggests an audit feature that never fires.

**Source:** `security-findings.md` §M5.

#### M6 — User deletion via Clerk webhook orphans subscription rows

**File:** `convex/users/actions.ts:39-49`

```ts
export const remove = internalMutation({
  args: { clerkUserId: v.string() },
  async handler(ctx, { clerkUserId }) {
    const user = await userByExternalId(ctx, clerkUserId)
    if (user !== null) {
      await ctx.db.delete('users', user._id)  // only deletes the user row
    } else {
      console.warn(...)
    }
  },
})
```

When a Clerk user is deleted, the `users` row is removed but the user's
`subscriptions`, `refreshLog`, and `machineActivity` rows remain. The
cron then continues to:
- refresh the orphan subscriptions every 10 minutes (Anthropic API quota burn)
- poll usage every 5 minutes (more quota burn)

If a user with the same `externalId` is later created, they would have
no subs in the dashboard but the orphan rows still exist with the OLD
`userId`, dangling forever.

**Fix:** In `users.actions.remove`, also soft-remove (or hard-delete)
all subscriptions and audit rows for the user. Consider doing this via
a scheduled action so it can chunk if the user has many rows:

```ts
const subs = await ctx.db.query('subscriptions')
  .withIndex('byUserAndSlot', (q) => q.eq('userId', user._id))
  .collect()
for (const sub of subs) {
  await ctx.db.patch('subscriptions', sub._id, { removedAt: Date.now() })
}
```

#### M7 — `loadMasterKey` "must be base64-encoded" error is unreachable

**File:** `convex/subscriptions/crypto.ts:30-39`

```ts
let key: Buffer
try {
  key = Buffer.from(raw, 'base64')
} catch {
  throw new Error('VAULT_AES_KEY must be base64-encoded')
}
```

`Buffer.from(<garbage>, 'base64')` does not throw — Node silently
returns whatever bytes it could decode. So the `try/catch` is dead
code; the helpful "must be base64-encoded" error never fires. The
length check that follows catches the silent decoding failure but with
a less helpful message. Confirmed via:

```
$ node -e "console.log(Buffer.from('!!!not base64!!!', 'base64').length)"
6
```

**Fix:** Validate the input is base64 syntactically before decoding:

```ts
if (!/^[A-Za-z0-9+/]+=*$/.test(raw)) {
  throw new Error('VAULT_AES_KEY must be base64-encoded (got non-base64 chars)')
}
const key = Buffer.from(raw, 'base64')
if (key.byteLength !== KEY_LENGTH_BYTES) { ... }
```

Or just delete the unreachable try/catch and rely on the length check.

---

### Low (polish)

#### L1 — Token-redaction regex uses lowercase-only prefix character class

**File:** `convex/subscriptions/redact.ts:14`

```ts
const TOKEN_RE = /sk-ant-[a-z]+\d+-[A-Za-z0-9_-]{20,}/g
```

If Anthropic ever issues `sk-ant-OAT01-...` (or any uppercase prefix),
redaction silently fails. Reproduced:

```
$ node -e "console.log('sk-ant-OAT01-AAAAAAAAAAAAAAAAAAAA'.replace(/sk-ant-[a-z]+\d+-[A-Za-z0-9_-]{20,}/g, '<r>'))"
sk-ant-OAT01-AAAAAAAAAAAAAAAAAAAA   # NOT redacted
```

**Fix:** Loosen the prefix-letters class to `[A-Za-z]+`, and add a
property test that randomized token-shaped strings always redact.

**Source:** `security-findings.md` §L4.

#### L2 — CLI commands still use string-keyed action refs after backend exposed the typed surface

**File:** `cli/src/commands/{add,refresh,switch,sync,list,remove,status}.ts`

Per IMPLEMENTATION_NOTES.md, the backend has shipped the typed
`api.subscriptions.actions.upsertFromPlaintext`, `requestRefresh`, etc.
The CLI has a `tsconfig.json` path alias `@cvault/convex/api` ready,
but every command still uses the placeholder pattern:

```ts
const upsertActionRef = {
  _name: 'subscriptions/actions:upsertFromPlaintext',
} as unknown as Parameters<typeof client.action>[0]

await client.action(upsertActionRef, {
  email: ...,
} as never)
```

This **silently erases** the type-safety the spec §15 calls out
("generated types via `convex/_generated/api` removes drift"). The CLI
will compile and run, but a backend signature change won't be caught
at CLI compile time.

**Fix:** Switch every CLI command to import from `@cvault/convex/api`:

```ts
import { api } from '@cvault/convex/api'
// ...
await client.action(api.subscriptions.actions.upsertFromPlaintext, {
  email: account.email,
  plaintextBlob,
  expiresAt: oauth.expiresAt,
  subscriptionType: oauth.subscriptionType,
  rateLimitTier: 'tier1',
  ...(opts.label !== undefined ? { label: opts.label } : {}),
})
```

This eliminates the `as unknown as` and `as never` chains entirely —
note these casts technically violate the user's `as any` rule via the
`as never` form (assignment to `never` is structurally `as any`).

#### L3 — `readSession` returns `parsed as SessionState` without validating shape

**File:** `cli/src/auth/session.ts:62-78`

If `~/.vault/session.json` is corrupted (but parseable JSON), property
accesses downstream throw `TypeError: Cannot read properties of undefined`,
not the helpful `"Failed to parse"` error.

**Fix:** Validate via Zod in the read path:

```ts
import { z } from 'zod'
const SessionStateSchema = z.object({
  version: z.literal(1),
  clerkSessionId: z.string(),
  clerkSessionToken: z.string(),
  convexJwt: z.string(),
  convexJwtExpiry: z.number(),
  frontendApiUrl: z.string().url(),
  convexUrl: z.string().url(),
  issuedAt: z.number(),
  clerkUserId: z.string().optional(),
  machineLabel: z.string().optional(),
})
// inside readSession:
const result = SessionStateSchema.safeParse(parsed)
if (!result.success) {
  throw new Error(`session.json shape is invalid: ${result.error.message}. Re-run cvault login.`)
}
return result.data
```

#### L4 — `pullForSwitch` falls back to `'unknown-session'` sentinel when `sid` claim missing

**File:** `convex/subscriptions/actions.ts:78-79`

```ts
const sidClaim = (identity as { sid?: unknown }).sid
const clerkSessionId = typeof sidClaim === 'string' ? sidClaim : 'unknown-session'
```

If many users hit this path with a missing `sid`, the audit row collapses to a single fake "machine" called `unknown-session`, breaking the per-machine drilldown query.

**Fix:** Either change `clerkSessionId` to `v.optional(v.string())` in `machineActivity` schema and pass `null`/skip recording, or define a `getClerkSessionId(identity)` helper in `utils/auth.ts` and have callers handle the null case explicitly.

**Source:** `security-findings.md` §L1.

#### L5 — `lastHashPath` doesn't sanitize null bytes, newlines, or RTL-override characters

**File:** `cli/src/paths.ts:104-112`

```ts
const safe = email
  .replace(/\.\.[/\\]/g, '__')
  .replace(/\.\./g, '__')
  .replace(/[/\\]/g, '_')
```

Tested:
- `"\0"` (null byte) — passes through
- `"\n"` (newline) — passes through
- RTL-override `‮` — passes through

Emails come from the user's claude-swap export, which is user-controlled
per machine. A malicious local actor (or mistakenly-typed email) could
in principle inject characters that affect log readability or terminal
rendering. Not an exploit vector but a hardening miss.

**Fix:** Whitelist instead of blacklist:

```ts
const safe = email.replace(/[^A-Za-z0-9@._-]/g, '_')
```

#### L6 — Test seam globals (`_fetch`, `_randomBytes`) are process-wide mutable state

**File:** `convex/subscriptions/anthropic.ts:25-42`

Vitest 4 supports parallel files within a project. If two test files
in `convex-edge` ever run concurrently and both reach into the
`__setAnthropicFetch` seam, one's stub leaks into the other. Today
`afterEach` resets the seams, but parallel-within-file scheduling
isn't guaranteed.

**Fix:** Make the test seam a function arg to `refreshAccessToken` /
`fetchUsage` so each call carries its own fetch:

```ts
export async function refreshAccessToken(
  refreshToken: string,
  opts: { fetch?: typeof fetch } = {}
): Promise<RefreshResult> {
  const fn = opts.fetch ?? fetch
  ...
}
```

**Source:** `security-findings.md` §L3.

#### L7 — Convex webhook upserts use `v.any() as Validator<UserJSON>`

**File:** `convex/users/actions.ts:14`, `convex/organizations/actions.ts:18`,
`convex/organizationMembers/actions.ts:28,47`

```ts
args: { data: v.any() as Validator<UserJSON> }
```

Pre-existing Blueprint code, but the `as` cast violates the user's
"no `as any`" rule via the `Validator<UserJSON>` assertion through
`v.any()`. Internal mutations have no schema enforcement; a
mis-shaped call (programming error) writes garbage to the `users`
table.

**Fix:** Replace with a strict `v.object({...})` validator matching
the subset of `UserJSON` the handler actually reads. **Source:**
`security-findings.md` §M6 (downgraded to Low here because it's
pre-existing Blueprint code, not new cvault).

#### L8 — 95 files have prettier formatting issues

**File:** repo-wide

`yarn format:check` reports 95 files with style issues. This was
clean per IMPLEMENTATION_NOTES.md but `format:check` was not part
of the verification baseline. Run `yarn format:fix` before commit.

---

### Info (deferred / out-of-scope but worth noting)

#### I1 — No live Anthropic refresh scenario test (deferred per IMPLEMENTATION_NOTES)

Per spec §11 the `__scenarios__/refreshCycle.scenario.ts` gated on
`VAULT_TEST_REFRESH_TOKEN` is acknowledged as deferred. The scenario
plan in `docs/research/scenario-tests-plan.md` is comprehensive but
not implemented. Add when a real refresh token is available.

#### I2 — No exponential backoff in refresh cron (deferred per spec §13)

Per spec §13 explicitly v2. A persistently-broken Anthropic endpoint
would cause every 10-minute tick to re-fetch (the lease prevents
overlapping calls per sub, but each tick still spawns a fresh attempt).

#### I3 — No per-user mutation rate limit (deferred per spec §12)

Mentioned in `security-findings.md` §M3. Force-refresh and
`upsertFromPlaintext` are the most attacker-attractive endpoints
(cheap for caller, expensive for upstream Anthropic).

#### I4 — `convex-config.json` is gitignored but `.env.example` lacks `VAULT_AES_KEY`

`.env.example` documents `CONVEX_DEPLOYMENT` etc. but doesn't mention
`VAULT_AES_KEY` (the master encryption key). New deployments that
follow `.env.example` will hit "VAULT_AES_KEY env var is not set"
on first encrypt call. Document the `npx convex env set VAULT_AES_KEY`
step in `.env.example` (as a comment) and in README setup instructions.

#### I5 — `.env.local` contains a Clerk dev secret key

`.env.local` is gitignored, so the secret never reaches git. But the
file is committed to the user's local disk and the secret is for the
shared Blueprint dev tenant. Acceptable as a dev-only setup, but
production deploys must use a separate Clerk prod tenant + Convex
deploy + `.env.local`. Worth a one-line README note.

---

## Spec deviation review (per IMPLEMENTATION_NOTES.md)

The five backend deviations called out in `IMPLEMENTATION_NOTES.md` line 104+:

1. **400 invalid_grant → reloginRequired** — ✓ Justified per OAuth research brief; spec §10 mentions only 401, but providers commonly return 400. Test coverage at `refresh.test.ts:119-142` covers 401; **a test for 400 is missing** — recommend adding one as a regression for the deviation.

2. **`getIdentity(ctx)` helper instead of fixing the wrapper typing** — ✓ Justified pragmatically (Convex's `QueryBuilder` cast strips the augmentation). Trade-off acceptable; the helper does belt-and-braces shape validation. **Caveat:** `Object.assign(ctx, { identity })` mutates the ctx object — if Convex ever reuses ctx across handlers, this could cross-contaminate. Verify Convex's contract; if uncertain, switch to a fresh wrapper object.

3. **`upsertFromPlaintext` action delegating to internal mutation** — ✓ Correct pattern; the action does `'use node'` + AES-GCM encrypt, the mutation persists. No cross-tenant issues — `upsertEncrypted` accepts `externalId` and re-resolves the user.

4. **Vitest 4 `projects` config** — ✓ Better than the deprecated `environmentMatchGlobs`.

5. **Pull-on-use double-fetch** — ✓ Acceptable; one extra `runQuery` is cheap.

**Undeclared deviation:** the CLI's string-keyed action refs (L2) are not in the deviations list but materially undermine the spec §15 type-safety guarantee.

---

## Test quality review

**Strengths:**
- Cross-user isolation covered for `subscriptions.queries.listForUser` and `refreshLog.queries.recentForUser`.
- `requestRefresh` cross-tenant check covered (`refresh.test.ts:204-228`).
- Encryption roundtrip + tamper + nonce uniqueness + key-length all tested in `crypto.node.test.ts`.
- Lease CAS, lease loss, lease TTL expiry, holder-token enforcement all tested.
- Token redaction tested for both `oat01` and `ort01` shapes plus error-message embedding.
- CLI tests cover offline degradation, hash skip/import paths, callback server timing-safe state, missing binary handling.
- Frontend tests cover skeleton loading, empty state, action wiring, sign-in gating.

**Gaps:**
- **Critical:** no test for cross-tenant `revokeSession` (C1). The existing test only verifies the action calls Clerk; nothing checks ownership.
- No test for 400 `invalid_grant` body (covers only 401 per spec; the deviation widening to 400 is untested).
- No test for `decrypt` failure inside `refreshOAuthToken` / `fetchUsageForSub` (H4 lease-leak path is uncovered).
- No test for `pullForSwitch` returning stale plaintext after a failed proactive refresh (H3).
- No test for the dashboard "Force Refresh" button actually calling `requestRefresh` (the test confirms a mutation is called for Remove, not for Force Refresh — H2 went unnoticed because the test doesn't assert the action wires up).
- No test for orphan-subscription cleanup on user deletion (M6).
- No test for `findExpiringSubs` with a frozen clock to surface M1 cache-invalidation hazard.

---

## Praise (genuine)

- **Encryption envelope** is by-the-book AES-256-GCM with proper nonce
  generation, tag-trailer layout, and node-runtime gating. Decrypt
  throws on tamper as intended; the test suite catches both ciphertext
  and nonce corruption.
- **Refresh-race lease protocol** is robust: atomic CAS, 30s TTL,
  holder-token-bound release/commit, loser path is bounded (sleep 1s
  then re-check), and `commitRefreshedTokens` throws `LEASE_LOST`
  defensively if the holder mismatches mid-refresh.
- **Authenticated wrappers** are clean: `authenticatedQuery`,
  `authenticatedMutation`, `authenticatedAction` all consistent, and
  `getIdentity(ctx)` does belt-and-braces shape validation.
- **CLI localhost callback** is correctly implemented: 127.0.0.1
  binding, port=0 OS-assignment, `node:crypto.timingSafeEqual` with
  length pre-check, 2-minute hard timeout, single-shot accept.
- **Test quality** is generally high — cross-user isolation tested, error
  paths tested (401, 503, lease loss, 429), redaction tested,
  offline degradation tested, RTL `cleanup()` configured for
  Testing Library.
- **Spec deviations are documented** in `IMPLEMENTATION_NOTES.md`
  with justifications and downstream impact called out.
- **Convex MCP rules** are followed: `internalAction` for cron
  workers, no `api.*` in `crons.ts`, internal queries for the
  ciphertext-returning paths.

---

## Recommendation: **Request changes**

Block production deployment until C1 is fixed (cross-tenant session
revocation is a real authz hole). H1-H4 should be fixed in the same
window since each undermines a primary user-facing flow (CLI auth, force
refresh, switch, refresh credibility). M1-M7 are mergeable-with-followup
but should be cleaned up before any external user gets a `cvault add`.

Approximate effort to clear all Critical + High: **~4-6 focused hours**
(C1: 1h with tests, H1: 30min, H2: 30min, H3: 30min, H4: 1-2h with tests).

Once Critical + High are resolved, the codebase is genuinely production-ready
for single-user deployment per the spec's intent. The structural quality is
high — these are pre-launch fix-ups, not redesigns.
