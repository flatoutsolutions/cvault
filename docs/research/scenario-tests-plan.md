# cvault — Scenario (E2E) Test Plan

**Date:** 2026-05-02
**Status:** Plan, awaiting implementation approval
**Owner:** Stefan (single user, multi-machine)
**Spec:** [docs/superpowers/specs/2026-05-02-cvault-design.md](../superpowers/specs/2026-05-02-cvault-design.md)

---

## 1. Intent

Per spec §11, every layer (Convex backend, TypeScript/Bun CLI, TanStack
frontend) already has thorough unit + per-domain integration coverage:

| Layer | Tests today |
|---|---|
| Convex backend | 70 tests across 13 files (mutations, queries, actions, crons, crypto, redact, http, cli auth) |
| CLI | 14+ files covering each command, claude-swap subprocess wrapper, callback server, FAPI exchange, paths, render |
| Frontend | 10 files covering each route + each dashboard component |

What's **not** tested today is the **end-to-end happy path stitched
through all three layers**: a real user signing up via Clerk → CLI
captures session → uploads cred via the Convex action → cron refreshes
the cred → second machine pulls → frontend displays the live state →
user revokes a session.

This plan defines those scenario tests. They are the
"reads-like-the-spec" tests: each one maps 1:1 to a numbered scenario
in the user's task brief and to one or more user-facing flows in spec
§7 / §8.

### Distinction from existing tests

| Test class | Suffix | Runner | Scope |
|---|---|---|---|
| Unit | `*.test.ts` | `yarn test` (default) | Single function/component, all deps mocked |
| Integration | `*.integration.test.ts` | `yarn test:integration` | Convex pipeline (in-memory) |
| **Scenario (this plan)** | `*.scenario.test.ts` | `yarn test:scenario` | Full flow across CLI + Convex + (optional) frontend |

Scenario tests live alongside the layer they're driven from
(`convex/__scenarios__/`, `cli/tests/scenarios/`,
`frontend/src/__tests__/scenarios/`) but are excluded from the default
run via `vitest.config.ts`'s top-level `exclude` glob
(`'**/*.scenario.test.ts'`) — they only run via the dedicated
`vitest.scenario.config.ts` (which is already wired into
`yarn test:scenario`).

The existing scenario config already gives them 5-minute test timeouts
and 2-minute hook timeouts, which is appropriate because a few of these
flows make real Anthropic / Clerk calls when explicitly enabled.

### Naming + layout convention

Each scenario file imports the layers it exercises. We do **not** stand
up a separate orchestration project. The flows compose existing
machinery:

- `convex-test`'s in-process `vault()` harness from
  `convex/__tests__/helpers.ts` for backend.
- The CLI command runners (`runLogin`, `runAdd`, `runSwitch`,
  `runSync`, `runRefresh`, `runRemove`, `runStatus`, `runList`) imported
  directly. The CLI never spawns its own binary in scenarios — running
  `runX(opts)` against an in-process `convex-test` instance gives us
  full-stack coverage with zero process boundary noise.
- For frontend scenarios that need real DOM interaction (#9 Force
  Refresh button, #11 Revoke), Vitest + React Testing Library is enough
  (Playwright is **not** required because the dashboard is wired with
  the same Convex live-query hooks that already work via the
  `convex/react` mock pattern in existing route tests).

The only place we deviate from "all in-memory" is the optional, gated
**live** scenario (refresh against a real Anthropic refresh token, gated
on `VAULT_TEST_REFRESH_TOKEN`) per spec §11.

---

## 2. Scenario index

| # | Scenario | Primary layer | Framework | File |
|---|---|---|---|---|
| 1 | First-machine bootstrap | CLI (+ in-mem Convex) | Vitest (Bun runner) | `cli/tests/scenarios/firstMachineBootstrap.scenario.test.ts` |
| 2 | Add account flow | CLI (+ in-mem Convex) | Vitest (Bun runner) | `cli/tests/scenarios/addAccount.scenario.test.ts` |
| 3 | List with usage | CLI (+ in-mem Convex) | Vitest (Bun runner) | `cli/tests/scenarios/listWithUsage.scenario.test.ts` |
| 4 | Switch on same machine | CLI (+ in-mem Convex) | Vitest (Bun runner) | `cli/tests/scenarios/switchSameMachine.scenario.test.ts` |
| 5 | Switch on second machine (sync) | CLI (+ in-mem Convex) | Vitest (Bun runner) | `cli/tests/scenarios/switchSecondMachine.scenario.test.ts` |
| 6 | Auto-refresh near expiry (cron) | Convex backend | Vitest (edge-runtime) | `convex/__scenarios__/refreshCycle.scenario.test.ts` |
| 7 | Refresh race | Convex backend | Vitest (edge-runtime) | `convex/__scenarios__/refreshRace.scenario.test.ts` |
| 8 | Refresh dead (relogin required) | Convex backend + frontend | Vitest (edge-runtime + jsdom) | `convex/__scenarios__/refreshReloginRequired.scenario.test.ts` + `frontend/src/__tests__/scenarios/reloginBadge.scenario.test.tsx` |
| 9 | Force-refresh button | Frontend (+ in-mem Convex) | Vitest (jsdom) | `frontend/src/__tests__/scenarios/forceRefreshButton.scenario.test.tsx` |
| 10 | Force remove | Frontend + CLI | Vitest (jsdom + Bun) | `frontend/src/__tests__/scenarios/forceRemove.scenario.test.tsx` + `cli/tests/scenarios/listAfterRemove.scenario.test.ts` |
| 11 | Revoke machine | Frontend (+ in-mem Convex) | Vitest (jsdom) | `frontend/src/__tests__/scenarios/revokeMachine.scenario.test.tsx` |
| 12 | Offline degradation on CLI | CLI | Vitest (Bun runner) | `cli/tests/scenarios/offlineDegradation.scenario.test.ts` |
| 13 | Encryption integrity | Convex backend (+ CLI) | Vitest (node) | `convex/__scenarios__/encryptionIntegrity.scenario.test.ts` |
| 14 | Token redaction in logs | Convex backend | Vitest (edge-runtime) | `convex/__scenarios__/tokenRedaction.scenario.test.ts` |
| 15 *(deferred / live-only)* | Live Anthropic refresh roundtrip | Convex backend | Vitest (node) — gated on env | `convex/__scenarios__/liveAnthropicRefresh.scenario.test.ts` |

**Total scenario files:** 14 + 1 deferred (live-only) = **15 files**.
**Total scenarios:** the 14 numbered items, several of which span 2
files where they cross layers (8, 10).

Frameworks count:

| Framework | Files |
|---|---|
| Vitest, edge-runtime project | 4 (`refreshCycle`, `refreshRace`, `refreshReloginRequired`, `tokenRedaction`) |
| Vitest, node project | 2 (`encryptionIntegrity`, `liveAnthropicRefresh`) |
| Vitest, jsdom project (frontend) | 4 (`reloginBadge`, `forceRefreshButton`, `forceRemove`, `revokeMachine`) |
| Vitest, Bun runner (CLI) | 7 (the seven CLI-driven scenarios) |
| Playwright | 0 — see §6 |

---

## 3. Helpers we'll add (one shared module per layer)

To avoid duplicating bootstrap noise across 14 scenario files, the plan
introduces three thin helpers. They are **new** files, not edits to
existing tests:

### `convex/__scenarios__/scenarioHarness.ts`
Re-exports `vault()`, `seedUser()`, `TEST_IDENTITY`, `SECOND_IDENTITY`
from `convex/__tests__/helpers.ts`, plus a couple of scenario-only
sugar helpers:
- `seedSubscription({ t, identity, email, expiresAt, refreshExpiresAt?, label?, oauthBlob? })` — wraps the existing pattern of "encrypt blob → call public `upsert` mutation"; returns `{ subId, slot, blob }`.
- `mockAnthropicRefreshOnce({ status, body? })` — installs a one-shot stub via `__setAnthropicFetch`, auto-resets on `afterEach` (uses the same teardown shape as `convex/subscriptions/refresh.test.ts`).
- `mockClerkOnce({ url, status, body })` — same idea for `__setClerkFetch`.

### `cli/tests/scenarios/scenarioHarness.ts`
Owns the cross-cutting CLI scenario boilerplate:
- `withTempHome(fn)` — `mkdtempSync` / `vi.stubEnv('HOME', tmp)` / cleanup. The pattern that's already inlined in `cli/tests/commands/switch.test.ts`.
- `mockClaudeSwap({ statusOutput, exportEnvelope, importedEnvelopes })` — installs the `claudeSwap` `vi.mock` block used by every CLI command test, but keeps a reference to the captured `importEnvelope` calls so a scenario can assert "this exact blob was passed to claude-swap".
- `inMemoryVaultClient(t)` — adapts the `convex-test` `t` instance into the `VaultClient` shape the CLI commands expect (`{ query, action }`). Wires `t.withIdentity(TEST_IDENTITY).query/action` underneath. This is the load-bearing piece — it lets a CLI command run end-to-end against the in-memory Convex without ever opening a real socket.

### `frontend/src/__tests__/scenarios/scenarioHarness.tsx`
- `renderWithConvex({ subs, refreshLog?, machineActivity?, mutations? })` — a `convex/react` mock harness that returns the supplied data from `useQuery` and routes `useMutation` / `useAction` calls to spies the test can inspect. Same shape as `frontend/src/__tests__/routes/dashboard.test.tsx`'s `useQueryMock` + `mutationsByName` map, just hoisted into a reusable factory.

Each shared harness file is itself trivial enough to skip a unit test
of its own (it's all glue around already-tested machinery), and the
scenarios that use it provide the assertions that prove it works.

---

## 4. Per-scenario detail

### 4.1 First-machine bootstrap (scenario #1)

**File:** `cli/tests/scenarios/firstMachineBootstrap.scenario.test.ts`
**Layer focus:** CLI auth flow + Convex `users` row creation
**Maps to:** spec §7 (`cvault login`), §15 (sign-in token + ticket flow)

**Test framework**
Vitest (Bun runner). Inherits the existing `cli/vitest.config.ts` setup
file (`tests/setup.ts`) and is excluded from the default run via the
top-level `'**/*.scenario.test.ts'` exclude glob in
`vitest.config.ts`. Runs via `yarn test:scenario`.

**Setup**
- Use `withTempHome()` from `scenarioHarness` so `~/.vault/` lands in a
  per-test tmpdir.
- Mock `auth/callbackServer.startCallbackServer` to return a stable
  `{ port: 54321, result: Promise.resolve({ signInToken: 'sit_e2e' }) }`.
- Mock `auth/openBrowser.openBrowser` to a no-op.
- Mock `auth/clerkFapi.exchangeTicketForSession` to return a fixture
  `SessionState`. (We do **not** hit the real Clerk FAPI here. That's
  Clerk's contract; our existing unit tests in
  `cli/tests/auth/clerkFapi.test.ts` already cover the response
  shape.)
- Use the in-memory `vault()` harness to represent Convex.
- Pre-seed Clerk's webhook side: insert a `users` row with
  `externalId === TEST_IDENTITY.subject` to model what Clerk's
  `user.created` webhook does in production. The webhook itself has
  unit coverage in `convex/webhooks/clerk.ts`; this scenario only
  needs the side-effect (a `users` row).

**Run**
- Call `runLogin(opts)` with the mocked dashboard URLs.

**Assertions**
- `~/.vault/session.json` exists.
- Stat the file: `mode & 0o777 === 0o600`.
- Stat the dir: `mode & 0o777 === 0o700`.
- Parse the file → `version: 1`, `clerkSessionId`, `clerkSessionToken`,
  `convexJwt` non-empty.
- Decode the `convexJwt`'s `exp` claim and confirm `convexJwtExpiry`
  in the persisted file matches.
- A `users` row exists in the `vault()` instance with the expected
  externalId. (We're modelling the webhook here, not testing it; the
  scenario asserts what the system depends on, not what created it.)

**Skip conditions**
None — this scenario uses no live dependencies.

**Estimated runtime**
~200 ms.

---

### 4.2 Add account flow (scenario #2)

**File:** `cli/tests/scenarios/addAccount.scenario.test.ts`
**Layer focus:** `claude-swap` capture → Convex
`upsertFromPlaintext` action → ciphertext at rest.
**Maps to:** spec §5 (`upsertFromPlaintext`), §6 (encryption envelope),
§7 (`cvault add`).

**Test framework**
Vitest (Bun runner). Same project as #1.

**Setup**
- `withTempHome()`.
- `mockClaudeSwap({ statusOutput: 'Active account: 1 (work@example.com)\n', exportEnvelope: singleAccountEnvelope({ number: 1, email: 'work@example.com' }) })`.
- In-memory `vault()` instance, `seedUser()` against `TEST_IDENTITY`,
  identity already injected.
- Set `process.env.VAULT_AES_KEY = base64(32 bytes)`. (Convex-side env
  var; real prod sets via `npx convex env set`.)

**Run**
- `runAdd({ label: 'work-mac' })` against the in-memory client.

**Assertions**
- Exactly one row in `subscriptions` table.
- Row has `userId === seededUser._id`, `email === 'work@example.com'`,
  `slot === 1`, `label === 'work-mac'`.
- **Critical:** row's `ciphertext` is `Uint8Array`-shaped, not the
  plaintext blob. Do
  `expect(Buffer.from(row.ciphertext).toString('utf8')).not.toMatch(/sk-ant-oat01/)`
  to confirm we never store plaintext, even partially.
- Decrypt the row in-test using `subscriptions/crypto.decrypt(...)` and
  assert the recovered plaintext parses to `{ claudeAiOauth: { accessToken: 'sk-ant-oat01-...', ... } }`.
- Confirm a "list" path works post-add: a follow-up
  `t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser)`
  returns `[ { email: 'work@example.com', slot: 1, ... } ]` with
  `ciphertext`/`nonce` stripped. (Validates the wire shape the
  dashboard relies on.)

**Skip conditions**
None.

**Estimated runtime**
~300 ms.

---

### 4.3 List with usage (scenario #3)

**File:** `cli/tests/scenarios/listWithUsage.scenario.test.ts`
**Layer focus:** `cvault list` reads usage figures populated by
`fetchUsageForSub` cron action; active marker matches local
`claude-swap --status`.
**Maps to:** spec §5 (`pollUsage`, `fetchUsageForSub`), §7 (`cvault list`).

**Test framework**
Vitest (Bun runner).

**Setup**
- `withTempHome()`.
- In-memory Convex with one seeded sub via `seedSubscription({ slot: 1, email: 'a@b.com' })`.
- Stub the Anthropic usage endpoint via `__setAnthropicFetch` to return
  `{ five_hour: { utilization: 23.5, resets_at: <future ISO> }, seven_day: { utilization: 47.0, resets_at: <future ISO> } }`.
- Run the cron worker in-test:
  `t.action(internal.subscriptions.crons.pollUsage, {})` — this is the
  same code path the deployed cron schedules.
- `mockClaudeSwap({ statusOutput: 'Active account: 1 (a@b.com)\n' })`.
- Capture `console.log` so the rendered table is inspectable.

**Run**
- `runList()` against the in-memory client.

**Assertions**
- Console output contains "a@b.com".
- Console output contains a usage5h figure consistent with `23.5%`
  (the renderer rounds — current `cli/src/render/table.ts` uses
  `Math.round(pct)` per the unit tests; assert the rendered string
  matches that).
- Console output contains a usage7d figure consistent with `47%`.
- Active marker is on slot 1 (e.g. a "•" or "*" in the row, per
  `render/table.ts`).
- Direct DB read: `subscriptions[0].usage5h.pct === 23.5` and
  `usage7d.pct === 47.0` — proves the cron actually wrote the cache.

**Skip conditions**
None.

**Estimated runtime**
~400 ms.

---

### 4.4 Switch on same machine (scenario #4)

**File:** `cli/tests/scenarios/switchSameMachine.scenario.test.ts`
**Layer focus:** Hash match → no re-import; `claude-swap --switch-to`
called; `machineActivity` row inserted with `action: 'pull'` (note: the
implementation uses 'pull', not 'switch' — see §7 of this plan
"Spec/impl deviations").
**Maps to:** spec §7 (pull-on-use), §5 (`pullForSwitch`,
`machineActivity.record`).

**Test framework**
Vitest (Bun runner).

**Setup**
- `withTempHome()`.
- In-memory Convex with one seeded sub. Important: bootstrap the local
  cache so the hash matches:
  - Pre-encrypt the same plaintext server-side via the helper to get
    the deterministic `contentHash` (sha256 of plaintext).
  - Pre-write `~/.vault/last-hash-{email}.txt` with that hash so the
    CLI thinks the local Keychain is up to date.
- `mockClaudeSwap({ ...switchTo: vi.fn() })` — we don't care about
  status here, but we do want to see whether `importEnvelope` is
  called (it should not be) and whether `switchTo` is called (it
  should).
- Wire `inMemoryVaultClient(t)` so `runSwitch` uses Convex.

**Run**
- `runSwitch({ slotOrEmail: '1' })`.

**Assertions**
- `importEnvelope` was **not** called (hash-match short-circuit).
- `switchTo` was called with `1`.
- A `machineActivity` row exists for the user with
  `action === 'pull'` and `subscriptionId` matching the seeded sub.
- The row's `clerkSessionId` is non-empty (a real Clerk-shape `sid`
  claim or the impl's `'unknown-session'` fallback — assert one or
  the other rather than the literal string).

**Skip conditions**
None.

**Estimated runtime**
~300 ms.

---

### 4.5 Switch on a second machine (sync) (scenario #5)

**File:** `cli/tests/scenarios/switchSecondMachine.scenario.test.ts`
**Layer focus:** First call mismatches → `claude-swap --import`
runs; subsequent switch lands. Two distinct machines each leave a
`machineActivity` row.
**Maps to:** spec §7 (`cvault sync --all`, pull-on-use).

**Test framework**
Vitest (Bun runner).

**Setup**
- Two distinct `tempHome` dirs created back-to-back. Use a helper
  `withTwoTempHomes()` that yields `(home1, home2)`.
- One in-memory Convex `vault()` instance shared across both phases
  (this is what "central source of truth" means).
- Phase A (machine 1): seed a user + sub via the harness; this stands
  in for the first machine having previously run `cvault add`.
- Phase B (machine 2): switch HOME to `home2` (no `~/.vault/last-hash-*`
  exists), inject a *different* Clerk session id into the JWT
  (`sid` claim) so the `machineActivity.clerkSessionId` will differ
  per phase. Use a second `withIdentity({ ...TEST_IDENTITY, sid: 'sess_machine2' })`
  pattern — this requires augmenting `TEST_IDENTITY` in the harness with
  a custom `sid`.

**Run**
- Phase B step 1: `runSync()` — pulls every sub, imports each.
- Phase B step 2: `runSwitch({ slotOrEmail: 'a@b.com' })`.

**Assertions**
- After `runSync`: `~/.vault/last-hash-a@b.com.txt` (after `paths.lastHashPath` sanitization) exists in `home2` with mode 0600. `importEnvelope` was called once during sync.
- After `runSwitch`: `importEnvelope` was **not** called again
  (post-sync the local hash matches).
- `switchTo` was called with the right slot.
- The `machineActivity` table has at least 2 rows for the user (sync's
  per-pull row + switch's pull row — verify via
  `t.run(ctx => ctx.db.query('machineActivity').filter(...).collect())`).
- The two rows have distinct `clerkSessionId` values, proving the
  two machines were tracked independently.

**Skip conditions**
None.

**Estimated runtime**
~700 ms.

---

### 4.6 Auto-refresh near expiry (cron) (scenario #6)

**File:** `convex/__scenarios__/refreshCycle.scenario.test.ts`
**Layer focus:** Backend cron worker runs end-to-end with mocked
Anthropic. CLI on next switch sees new `contentHash`, re-imports.
**Maps to:** spec §5 (`refreshExpiringTokens`), §9, §10.

**Test framework**
Vitest (`convex-edge` project). Co-located with the existing
`subscriptions/crons.test.ts` patterns but in `__scenarios__/` and
with the `.scenario.test.ts` suffix so it's only picked up by
`yarn test:scenario`.

**Setup**
- `vault()`, seed one user + one sub with `expiresAt = Date.now() + 5 * 60 * 1000` (within the 15-min window).
- Stub Anthropic refresh via `__setAnthropicFetch` to return a 200 with
  `{ access_token: <new>, refresh_token: <new>, expires_in: 28800 }`.
- Snapshot the existing ciphertext + `contentHash` (decrypt → sha256).

**Run**
- Phase 1 (backend): `t.action(internal.subscriptions.crons.refreshExpiringTokens, {})`.
- Phase 2 (CLI side, simulated): re-pull via
  `pullForSwitch({ slotOrEmail: 'a@b.com' })` against the *same* user
  and inspect the returned `contentHash`.

**Assertions**
- Sub row's `expiresAt` advanced beyond `now + 60min`.
- Sub row's ciphertext changed (hex-compare bytes).
- One row in `refreshLog` with `triggeredBy === 'cron'`,
  `outcome === 'success'`.
- `pullForSwitch`'s returned `contentHash` differs from the
  pre-refresh snapshot — proving CLIs that cached the old hash will
  re-import on next switch (which is the entire point of the
  "auto-refresh propagates to all machines on next use" story).

**Skip conditions**
None.

**Estimated runtime**
~400 ms.

---

### 4.7 Refresh race (scenario #7)

**File:** `convex/__scenarios__/refreshRace.scenario.test.ts`
**Layer focus:** Lease CAS prevents double-spending the single-use
refresh token.
**Maps to:** spec §9.

**Test framework**
Vitest (`convex-edge` project).

**Setup**
- `vault()`, seed one user + one expiring sub.
- Stub Anthropic to count calls. Return 200 with a fresh tuple, but
  the stub's body uses a per-invocation counter so the second
  (losing) call would, if it happened, return *different* tokens —
  used as evidence later that the loser did not call.
- Drive concurrency with `Promise.all([refreshA, refreshB])` where each
  is a separate `t.action(internal.subscriptions.actions.refreshOAuthToken, ...)`.

**Run**
- `await Promise.all([
    t.action(internal.subscriptions.actions.refreshOAuthToken, { subId, triggeredBy: 'manual' }),
    t.action(internal.subscriptions.actions.refreshOAuthToken, { subId, triggeredBy: 'manual' }),
  ])`

**Assertions**
- `__setAnthropicFetch`'s stub was called **exactly once** (the loser
  saw a held lease, slept 1s, re-checked, found fresh tokens, aborted
  silently).
- `refreshLog` table has **exactly one** row with
  `outcome === 'success'`.
- Final sub row has the winner's tokens (decrypt + JSON.parse →
  matches the *first* counter value the stub generated).
- Sub's `refreshLeaseHolder === undefined` (lease cleanly released).

**Skip conditions**
None.

**Estimated runtime**
~1300 ms (the loser sleeps 1s per spec §9).

**Notes**
The 1s sleep in `refreshOAuthToken` is real `setTimeout`. The scenario
runs against wall-clock time (no fake timers) because the lease's
real-world property *is* "loser waits 1s, retries". Faking timers
would defeat the purpose. Hence the slightly long runtime.

---

### 4.8 Refresh dead (relogin required) (scenario #8)

**Files:**
1. `convex/__scenarios__/refreshReloginRequired.scenario.test.ts` (backend half)
2. `frontend/src/__tests__/scenarios/reloginBadge.scenario.test.tsx` (frontend half)

**Layer focus:** Anthropic returns 401 invalid_grant → `refreshExpiresAt = now`,
`refreshLog.outcome = 'reloginRequired'`. Frontend renders the warning
badge based on the resulting state.
**Maps to:** spec §10, §8 (dashboard relogin badge).

**Test framework**
Two scenarios because the layers are independent:
- Backend half: Vitest (`convex-edge` project).
- Frontend half: Vitest (`frontend` jsdom project).

**Setup (backend)**
- `vault()`, seed one expiring sub.
- Stub Anthropic 401 with body `{ error: 'invalid_grant', error_description: 'refresh token expired' }`.

**Run (backend)**
- `t.action(internal.subscriptions.actions.refreshOAuthToken, { subId, triggeredBy: 'manual' })`.

**Assertions (backend)**
- Sub row: `refreshExpiresAt <= Date.now()` (clamped to now).
- Sub row: lease holder cleared.
- `refreshLog`: one row, `outcome === 'reloginRequired'`.
- The error string in the log is non-empty and free of token-shaped
  substrings (this scenario doesn't include a leaked-token body —
  scenario #14 covers that — but we still assert no `sk-ant-` in the
  error to catch regressions).

**Setup (frontend)**
- Render `<SubscriptionCard sub={subWithReloginRequired} />` directly
  via `frontend/src/__tests__/scenarios/scenarioHarness.tsx`'s
  `renderWithConvex` helper, passing a sub fixture where
  `refreshExpiresAt < Date.now()`.

**Assertions (frontend)**
- The `ReloginBadge` component renders (look up via
  `data-slot="relogin-badge"` or `screen.getByText(/relogin/i)`).
- The card is visually de-emphasized per the existing
  `SubscriptionCard.test.tsx` pattern.

**Skip conditions**
None.

**Estimated runtime**
~300 ms each.

---

### 4.9 Force-refresh button (scenario #9)

**File:** `frontend/src/__tests__/scenarios/forceRefreshButton.scenario.test.tsx`
**Layer focus:** Dashboard click → `api.subscriptions.actions.requestRefresh` →
in-memory Convex runs the refresh → live query updates the card without
page reload.
**Maps to:** spec §8 (Force Refresh per-card action).

**Test framework**
Vitest (`frontend` jsdom project).

**Important deviation**
The user task brief says
`api.subscriptions.actions.refreshOAuthTokenForUser`. The shipped
backend exposes `requestRefresh` instead (per `IMPLEMENTATION_NOTES.md`
"Frontend agent's earlier requests #3"). The scenario asserts against
the actual surface (`api.subscriptions.actions.requestRefresh`) and
notes the rename in a code comment.

Today the frontend's "Force Refresh" button is wired to a
`console.warn` placeholder (`routes/dashboard/index.tsx` lines 60-77).
**This scenario will fail until the frontend agent swaps the placeholder
for `useAction(api.subscriptions.actions.requestRefresh)`.** The
scenario therefore doubles as a "definition of done" check on that
follow-up. Plan calls for this scenario to be **written but skipped via
`it.skip`** until the wiring lands; see §7 of this plan.

**Setup**
- `renderWithConvex({ subs: [subFixtureNearExpiry], mutations: { /* spies */ }, actions: { 'subscriptions.actions.requestRefresh': spy } })`.
- (Optional, more thorough variant) — Run the page against an actual
  in-memory `vault()` via a custom `ConvexProvider` that routes to the
  `convex-test` instance. Defer this — it's overkill for the asserted
  behavior. Mock-based variant is sufficient.

**Run**
- `fireEvent.click(screen.getByRole('button', { name: /force refresh/i }))`.

**Assertions**
- The `requestRefresh` action spy was called with `{ subId: subFixture._id }`.
- The button enters a "loading" state (`disabled` while the action is
  pending) — assert via `toBeDisabled()` immediately after click.
- After the spy resolves, the button returns to the enabled state.
- (If we use the `vault()`-backed variant) the sub's `lastRefreshedAt`
  re-renders to a newer timestamp via the Convex live query — but only
  if we set up a real live-query path. Mark this as out of scope for
  this scenario; the live-query reactivity is exercised in the existing
  `SubscriptionCard.test.tsx` reactivity test.

**Skip conditions**
- `it.skip` until the frontend's placeholder is replaced by the real
  `useAction` call. Track via
  `IMPLEMENTATION_NOTES.md → frontend → "Force Refresh wiring"`.

**Estimated runtime**
~300 ms.

---

### 4.10 Force remove (scenario #10)

**Files:**
1. `frontend/src/__tests__/scenarios/forceRemove.scenario.test.tsx` (frontend half — click → softRemove)
2. `cli/tests/scenarios/listAfterRemove.scenario.test.ts` (CLI half — `cvault list` no longer shows it)

**Layer focus:** Dashboard click → `softRemove` → `removedAt` set →
list filters out → CLI agrees.
**Maps to:** spec §8, §10 (soft delete), §7 (`cvault list`).

**Test framework**
Vitest, two projects:
- jsdom for the frontend half.
- Bun-runner CLI project for the CLI half.

**Setup (frontend half)**
- `renderWithConvex({ subs: [subFixture], mutations: { 'subscriptions.mutations.softRemove': spy } })`.

**Run (frontend half)**
- `fireEvent.click(screen.getByRole('button', { name: /remove/i }))`.

**Assertions (frontend half)**
- Spy called with `{ email: subFixture.email }`.
- The row optimistically disappears from the rendered list (or shows a
  pending-removal state, depending on how `routes/dashboard/index.tsx`
  handles it — current impl tracks `removingByEmail`; assert the
  button is disabled during the in-flight call).

**Setup (CLI half)**
- `vault()`, seed user + sub. Issue
  `t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, { email: 'a@b.com' })`.
- `mockClaudeSwap({ statusOutput: 'No active account\n' })`.

**Run (CLI half)**
- `runList()` against the in-memory client.

**Assertions (CLI half)**
- Console output does **not** contain `a@b.com`.
- Console output is the empty-state rendering from `render/table.ts`.

**Hard delete (deferred)**
Per the user brief, hard delete via cron after 30d is **out of scope
for v1 scenario tests**. Note in this section: implementation TBD; when
that cron lands, add scenario #10b
(`hardDeleteCron.scenario.test.ts`).

**Skip conditions**
None on the existing halves.

**Estimated runtime**
~300 ms each.

---

### 4.11 Revoke machine (scenario #11)

**File:** `frontend/src/__tests__/scenarios/revokeMachine.scenario.test.tsx`
**Layer focus:** Dashboard `/machines` Revoke button → `cli.actions.revokeSession`
→ `revokeClerkSession` HTTP call to Clerk Backend API → CLI's next
mint of a Convex JWT returns 401/403/404 → CLI throws
`ClerkSessionExpiredError`.
**Maps to:** spec §7 (CLI handling of expired session), §8 (machines page).

**Test framework**
Vitest, jsdom for the dashboard half. The "next CLI call returns 401"
half is exercised via a unit-level assertion against
`cli/src/auth/clerkFapi.mintConvexJwt` with a mocked 401 response.

**Setup (frontend)**
- `renderWithConvex({ machines: [{ clerkSessionId: 'sess_target', lastSeenAt: now, lastIpHash: 'a1b2c3d4' }], actions: { 'cli.actions.revokeSession': spy } })`.
- Stub `__setClerkFetch` so when `revokeSession` action runs against
  the in-memory backend, it sees a 200 from Clerk's side. We do **not**
  call Clerk for real.

**Run (frontend)**
- `fireEvent.click(screen.getByRole('button', { name: /revoke/i }))`.

**Assertions (frontend)**
- Spy called with `{ clerkSessionId: 'sess_target' }`.
- The row's status changes to "revoked" (or disappears, depending on
  the page; today `routes/dashboard/machines.tsx` re-queries on
  success — assert the spy resolved without throwing and the table
  re-renders).

**Setup (CLI half)**
- Build a `SessionState` fixture with the long-lived Clerk session
  token of the now-revoked machine.
- Mock `global.fetch` for `${frontendApiUrl}/v1/client/sessions/<id>/tokens/convex`
  to return 401.

**Run (CLI half)**
- `mintConvexJwt(sessionFixture)`.

**Assertions (CLI half)**
- Throws `ClerkSessionExpiredError`. (Already covered by
  `cli/tests/auth/clerkFapi.test.ts`; the scenario re-asserts to make
  the cross-layer story explicit.)

**Skip conditions**
None.

**Estimated runtime**
~400 ms.

---

### 4.12 Offline degradation on CLI (scenario #12)

**File:** `cli/tests/scenarios/offlineDegradation.scenario.test.ts`
**Layer focus:** Convex unreachable → `runSwitch` falls back to
`claude-swap --switch-to` directly with a warning.
**Maps to:** spec §7 ("Offline degradation").

**Test framework**
Vitest (Bun runner).

**Setup**
- `withTempHome()`.
- `mockClaudeSwap({ ...switchTo: vi.fn() })`.
- Mock `makeVaultClient` to throw a network-shaped error (e.g.
  `'fetch failed: getaddrinfo ENOTFOUND ...convex.cloud'`).

**Run**
- `runSwitch({ slotOrEmail: '2' })`.
- Capture `console.warn`.

**Assertions**
- `console.warn` was called with a message matching `/offline|local cache/i`.
- `claudeSwap.switchTo` was called with `'2'` directly — i.e. CLI did
  fall back instead of throwing.
- `claudeSwap.importEnvelope` was **not** called.
- A second flavor: when the action call rejects with a *non-network*
  error (e.g. `'500 InternalError: VAULT_AES_KEY missing'`), the CLI
  re-throws (not a fallback — this is already covered in
  `cli/tests/commands/switch.test.ts` "does not swallow non-network
  errors", restated here for the scenario story).

**Skip conditions**
None.

**Estimated runtime**
~150 ms.

---

### 4.13 Encryption integrity (scenario #13)

**File:** `convex/__scenarios__/encryptionIntegrity.scenario.test.ts`
**Layer focus:** Tamper a `subscriptions.ciphertext` byte → next
`pullForSwitch` throws GCM auth-tag failure → surface as a clear
"creds corrupt — re-add" error → no plaintext leakage.
**Maps to:** spec §6, §10.

**Test framework**
Vitest (`convex-node` project — needs `node:crypto`).

**Setup**
- `vault()`, seed user + sub.
- Tamper one byte in the row's ciphertext via `t.run(ctx => ctx.db.patch('subscriptions', subId, { ciphertext: tampered }))`.
  Use the same `tampered.fill()`+XOR pattern from the existing
  `crypto.node.test.ts` "tampered ciphertext throws" test.

**Run**
- `t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, { slotOrEmail: 'a@b.com' })`.
- (Optionally also drive via the CLI path:
  `runSwitch({ slotOrEmail: 'a@b.com' })` against the in-memory
  client and assert the rendered error.)

**Assertions**
- The action **throws**.
- The thrown error's stringified `.message` does **not** contain any
  fragment that looks like plaintext (`/sk-ant-/`, `/accessToken/`,
  `/refreshToken/`).
- For the CLI variant: the CLI's `console.error` output mentions
  "creds corrupt" or "re-add" (matching `claudeSwap.ts` /
  `commands/switch.ts` error-surfacing). If the actual surfaced text
  is just the underlying GCM error, this scenario flags that as a UX
  bug to fix; the assertion still rejects on plaintext leakage.

**Skip conditions**
None.

**Estimated runtime**
~250 ms.

---

### 4.14 Token redaction in logs (scenario #14)

**File:** `convex/__scenarios__/tokenRedaction.scenario.test.ts`
**Layer focus:** Anthropic returns a 5xx with a body that echoes a
token-shaped string → `refreshLog.error` has the token replaced by
`<redacted>`.
**Maps to:** spec §6 (redaction), §10.

**Test framework**
Vitest (`convex-edge` project).

**Setup**
- `vault()`, seed expiring sub.
- `__setAnthropicFetch` returns a 500 with a response body containing
  a token-shaped substring like
  `Internal error processing sk-ant-ort01-XXXXXXXXXXXXXXXXXXXXXXXX`.

**Run**
- `t.action(internal.subscriptions.actions.refreshOAuthToken, { subId, triggeredBy: 'manual' })`.

**Assertions**
- `refreshLog`: one row, `outcome === 'failure'`.
- `refreshLog[0].error` contains `<redacted>`.
- `refreshLog[0].error` does **not** contain `sk-ant-ort01` or
  `sk-ant-oat01`.
- (Note: a similar test exists in `subscriptions/refresh.test.ts` for
  the 401 case — this scenario covers the 5xx case to ensure both
  branches redact. The `redact.test.ts` unit tests cover the regex
  itself; this scenario covers wiring.)

**Skip conditions**
None.

**Estimated runtime**
~200 ms.

---

### 4.15 Live Anthropic refresh roundtrip (deferred / live-only)

**File:** `convex/__scenarios__/liveAnthropicRefresh.scenario.test.ts`
**Layer focus:** Real Anthropic OAuth refresh endpoint, not stubbed.
**Maps to:** spec §11 ("`__scenarios__/refreshCycle.scenario.ts` —
live cycle against dev deploy, gated on `VAULT_TEST_REFRESH_TOKEN`").

**Test framework**
Vitest (`convex-node` project, which has real `node:crypto` and real
`fetch`).

**Setup**
- Skip block at the top:
  ```ts
  const liveToken = process.env.VAULT_TEST_REFRESH_TOKEN
  describe.skipIf(!liveToken)('live Anthropic refresh', () => { ... })
  ```
- `vault()`, seed sub whose plaintext blob's `refreshToken` is
  `process.env.VAULT_TEST_REFRESH_TOKEN`. Set `expiresAt = Date.now() - 1000` (already expired).
- Do **not** call `__setAnthropicFetch` — we want the real network call.

**Run**
- `t.action(internal.subscriptions.actions.refreshOAuthToken, { subId, triggeredBy: 'manual' })`.

**Assertions**
- Sub row's `expiresAt` advanced past `Date.now() + 60min` (Anthropic
  typically returns 8h).
- Decrypt the new ciphertext → `refreshToken` differs from the seed
  refresh token (Anthropic rotates on use).
- One `refreshLog` row, `outcome === 'success'`.

**Skip conditions**
- Default: skipped (env not set).
- Run with `VAULT_TEST_REFRESH_TOKEN=<real-token> yarn test:scenario`.
- **Important:** running this scenario *consumes* the token. The user
  needs to capture a fresh token from a real Claude Code login each
  time they want to run this scenario — there is no other way around
  that, OAuth refresh tokens are single-use.

**Estimated runtime**
1-3 seconds plus Anthropic network latency.

---

## 5. Framework matrix

| Scenario | Vitest project | Real network? | Real DOM? |
|---|---|---|---|
| 1 First-machine bootstrap | cli (Bun) | No | No |
| 2 Add account flow | cli (Bun) | No | No |
| 3 List with usage | cli (Bun) | No | No |
| 4 Switch on same machine | cli (Bun) | No | No |
| 5 Switch on second machine | cli (Bun) | No | No |
| 6 Auto-refresh near expiry | convex-edge | No | No |
| 7 Refresh race | convex-edge | No | No |
| 8a Refresh dead (backend) | convex-edge | No | No |
| 8b Refresh dead (frontend badge) | frontend (jsdom) | No | Yes |
| 9 Force-refresh button | frontend (jsdom) | No | Yes |
| 10a Force remove (frontend) | frontend (jsdom) | No | Yes |
| 10b Force remove (CLI list) | cli (Bun) | No | No |
| 11 Revoke machine | frontend (jsdom) | No | Yes |
| 12 Offline degradation | cli (Bun) | No | No |
| 13 Encryption integrity | convex-node | No | No |
| 14 Token redaction | convex-edge | No | No |
| **15 (deferred) Live refresh** | convex-node | **Yes** | No |

Playwright is intentionally **not** introduced. Justification:

- The dashboard is a thin Convex-driven SPA. Each route's logic is
  already covered by Vitest-jsdom tests against the same Convex hooks
  the runtime uses.
- Adding Playwright introduces a second test runner, a browser
  matrix, a slow startup tax, and a new flake surface — for assertions
  we can already make in jsdom. Per spec §11, frontend coverage is
  Vitest + Testing Library, and the existing route tests prove that
  approach works.
- The two scenarios that *might* justify a real browser (#9 force
  refresh, #11 revoke) both reduce to "click a button → the right
  Convex call fires → the live query refetches". jsdom + the
  `convex/react` mock pattern exercise both halves.
- If we ever need cross-browser reality (Chrome profile pickers, Mac
  Keychain prompts, browser drag-drop), revisit. Out of scope for v1.

---

## 6. Env var requirements

| Var | Scope | Why | Used by scenarios |
|---|---|---|---|
| `VAULT_AES_KEY` | always | Required by `subscriptions/crypto.encrypt/decrypt`. Set per-test in `beforeEach` to `Buffer.alloc(32, N).toString('base64')`. | All scenarios involving encryption (2, 4, 5, 6, 7, 8, 13, 14, 15) |
| `CLERK_SECRET_KEY` | when scenario hits `cli.actions.startLink` or `revokeSession` | Required by `cli/clerk.ts`. Tests inject a dummy `'sk_test_dummy_for_unit_tests'` plus a `__setClerkFetch` stub. | 1 (login flow), 11 |
| `VAULT_TEST_REFRESH_TOKEN` | live-only | Real refresh token to exercise scenario 15. | 15 |
| `HOME` | CLI scenarios | Stubbed via `vi.stubEnv('HOME', tmpdir)` to keep `~/.vault/` in test temp space. | 1, 2, 3, 4, 5, 10b, 12 |

No real Convex deploy URL, no real Anthropic / Clerk endpoints (except
scenario 15). All scenarios are hermetic by default.

---

## 7. Recommended CI matrix

| Job | Command | When |
|---|---|---|
| Default test suite | `yarn test` | Every PR + push to main. Excludes `*.scenario.test.ts` via the existing exclude glob. |
| Scenario suite (hermetic) | `yarn test:scenario` | Every PR + push to main. Runs scenarios 1-14. No env vars needed beyond `VAULT_AES_KEY` (set deterministically inside each test). |
| Live refresh | `yarn test:scenario --testNamePattern='live Anthropic refresh'` | Manually-dispatched workflow. Triggered with a one-off `VAULT_TEST_REFRESH_TOKEN` from the GitHub Actions workflow input. Skipped on PRs (the token is single-use; we don't want it consumed by every PR). |

Estimated total runtime for the hermetic scenario suite (1-14):
- Sum of "estimated runtime" rows above ≈ **5 seconds** in serial.
- Vitest runs files in parallel by default, so the wall-clock should be
  closer to 1.5 seconds (limited by scenario #7's mandatory 1s sleep).

For comparison, today's full unit + integration suite is sub-30s.
Scenarios add < 5%.

CI workflow recommendation: run `yarn test` and `yarn test:scenario` in
parallel jobs (they share no state). Block merge on both.

---

## 8. Spec / impl deviations to be aware of

While drafting this plan I noticed three places where the user's brief
talks about the spec but the shipped implementation has drifted (per
`IMPLEMENTATION_NOTES.md`). Calling them out here so the scenarios
assert against reality, not the brief:

1. **`refreshOAuthTokenForUser` is named `requestRefresh`** in the
   shipped backend (`convex/subscriptions/actions.ts:156`). Scenario
   #9 asserts against `requestRefresh`. The brief's name was the
   placeholder name; the rename is documented in
   `IMPLEMENTATION_NOTES.md → Frontend agent's earlier requests #3`.

2. **`machineActivity.action` for `pullForSwitch` is `'pull'`, not
   `'switch'`** in the shipped backend
   (`convex/subscriptions/actions.ts:83`). The user brief for
   scenario #4 says `action='switch'`. Either:
   - Treat the brief as the spec and update the impl to insert
     `action: 'switch'` from `pullForSwitch` (this matches `cvault
     switch` semantics from the user's perspective and matches spec
     §5's `machineActivity.action` enum which has both `'switch'`
     and `'pull'`).
   - Or treat the impl as the spec and update the brief.
   The plan's scenario asserts `action === 'pull'` to match shipped
   code, with a `// TODO` comment recommending the impl change. **This
   is a real spec/impl disagreement that needs a Stefan call.**

3. **The "Force Refresh" button is currently a `console.warn`
   placeholder** (`frontend/src/routes/dashboard/index.tsx:60-77`).
   Scenario #9 is written but `it.skip`'d until the frontend agent
   wires the real `useAction` call. Removing the `.skip` is the
   "definition of done" for that follow-up.

These deviations are read-only observations from this plan; no code
edits are part of it.

---

## 9. Out of scope (deferred, noted not designed)

Per the user brief and spec §2 + §14:

- **Hard-delete cron after 30d** (scenario #10 follow-up). Cron not
  implemented yet; when it lands, add `hardDeleteCron.scenario.test.ts`
  to scenario #10.
- **Multi-human team sharing** (spec §2 explicitly excludes; ToS
  violation).
- **Disaster recovery / encrypted backup export** (spec §14 deferred).
- **Slack / email notification on refresh failure** (spec §14 deferred).
- **Encryption key rotation tooling** (spec §14 deferred).
- **Cross-browser reality testing** (Mac Keychain prompts, browser
  drag-drop) — Playwright not introduced; revisit if needed.
- **Background daemon (`vault watch`) E2E** (spec §2 explicitly out
  for v1; pull-on-use only).

---

## 10. Summary

- **15 scenario files**, organized by primary layer:
  - Convex backend: 5 (`refreshCycle`, `refreshRace`,
    `refreshReloginRequired`, `tokenRedaction`, `encryptionIntegrity`)
    plus 1 deferred live test (`liveAnthropicRefresh`).
  - CLI: 7 (`firstMachineBootstrap`, `addAccount`, `listWithUsage`,
    `switchSameMachine`, `switchSecondMachine`, `offlineDegradation`,
    `listAfterRemove`).
  - Frontend: 4 (`reloginBadge`, `forceRefreshButton`, `forceRemove`,
    `revokeMachine`).
- **Frameworks:** Vitest only. Four projects already configured in
  `vitest.config.ts` (`convex-edge`, `convex-node`, `frontend`, `cli`).
  No Playwright. No new test framework.
- **Env vars:** `VAULT_AES_KEY` (per-test, deterministic),
  `CLERK_SECRET_KEY` (per-test, dummy), `HOME` (per-test, tmpdir),
  `VAULT_TEST_REFRESH_TOKEN` (only for the deferred live scenario).
- **Total runtime (hermetic, scenarios 1-14):** ≈ 1.5s wall-clock with
  Vitest parallelism, dominated by scenario #7's mandatory 1s lease
  sleep.
- **Spec/impl deviations flagged:** 3 (see §8). One —
  `machineActivity.action` for pulls — needs a Stefan call before
  scenario #4 lands.
- **Out of scope (deferred):** hard-delete cron, multi-human, DR
  backup, notifications, key rotation, real-browser E2E.

The plan adds zero new runtime dependencies, zero new CI jobs (reuses
the existing `yarn test:scenario` script and `vitest.scenario.config.ts`),
and zero new test conventions — it composes harnesses already in tree.

