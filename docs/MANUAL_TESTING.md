# cvault — Manual Testing Playbook

**Audience:** Stefan (single-user owner), running through full-stack validation of v1 once the in-flight review-driven fixes have landed.

**Source documents:**

- Spec — [`docs/superpowers/specs/2026-05-02-cvault-design.md`](superpowers/specs/2026-05-02-cvault-design.md)
- Builder log — [`IMPLEMENTATION_NOTES.md`](IMPLEMENTATION_NOTES.md)
- Scenario test plan — [`docs/research/scenario-tests-plan.md`](research/scenario-tests-plan.md)
- Security findings — [`docs/research/security-findings.md`](research/security-findings.md)
- Project overview — [`README.md`](../README.md)

Tick boxes off as you progress. If anything fails, see [§10 Reporting bugs](#10-reporting-bugs).

---

## Table of contents

1. [Pre-flight checklist](#1-pre-flight-checklist)
2. [Smoke tests (5-min full-stack sanity)](#2-smoke-tests-5-min-full-stack-sanity)
3. [Happy-path E2E (~15 min)](#3-happy-path-e2e-15-min)
4. [Multi-machine test](#4-multi-machine-test)
5. [Failure-mode tests](#5-failure-mode-tests)
6. [Security smoke (post-fix verification)](#6-security-smoke-post-fix-verification)
7. [Convex dashboard inspection](#7-convex-dashboard-inspection)
8. [Known-deferred items the user should NOT expect to work](#8-known-deferred-items-the-user-should-not-expect-to-work)
9. [What "passes" looks like](#9-what-passes-looks-like)
10. [Reporting bugs](#10-reporting-bugs)

---

## 1. Pre-flight checklist

Before booting anything, confirm the deployment-side and host-side prerequisites. These items are owned by the team-lead / project setup; you are only verifying.

### 1.1 Clerk JWT template named `convex` (lowercase)

Convex validates the Clerk-issued JWT against an issuer template. The template name is hard-coded in `convex/auth.config.ts` and must match exactly (lowercase `convex`).

- [ ] Go to <https://dashboard.clerk.com> and pick your cvault Clerk application
- [ ] In the left sidebar: **Configure → JWT templates**
- [ ] Confirm a template named exactly `convex` (lowercase) exists
- [ ] If absent, click **+ New template → Convex** (Clerk has a Convex preset). Save it. Do **not** rename it.
- [ ] Open the template and confirm it issues `aud`, `azp`, `exp`, `iat`, `iss`, `nbf`, `sub` (the Convex preset does this by default)

### 1.2 Clerk webhook configured

The webhook keeps the Convex `users` table in sync with Clerk's source of truth. cvault depends on this row existing for every authenticated request.

- [ ] In the Clerk dashboard sidebar: **Configure → Webhooks**
- [ ] Confirm an endpoint pointing at `<CONVEX_SITE_URL>/webhooks/clerk` (e.g. `https://your-slug.convex.site/webhooks/clerk`)
- [ ] Subscribed to at least: `user.created`, `user.updated`, `user.deleted`
- [ ] Copy the **Signing Secret** (starts with `whsec_`)
- [ ] Persist it on the Convex deployment:
  ```bash
  npx convex env set CLERK_WEBHOOK_SECRET "whsec_<paste-here>"
  ```

### 1.3 Convex deployment env vars

Verify all required Convex-side secrets are present (do **not** echo their values).

- [ ] Run `npx convex env list` and confirm each of these keys appears:
  - [ ] `VAULT_AES_KEY` — already set by the team-lead; do **not** rotate (key loss = unrecoverable per spec §6)
  - [ ] `CLERK_FRONTEND_API_URL` — e.g. `https://<your>.clerk.accounts.dev`
  - [ ] `CLERK_SECRET_KEY` — Clerk Backend API key (`sk_test_...` or `sk_live_...`); used by `cli.actions.startLink` and `revokeSession`
  - [ ] `CLERK_WEBHOOK_SECRET` — set in step 1.2
  - [ ] `CLERK_PUBLISHABLE_KEY`
- [ ] If any are missing, set them per [README §Required env vars](../README.md#required-env-vars). Never paste secrets into a chat or commit them to git.

### 1.4 Local frontend env vars

- [ ] In the repo root, confirm `.env.local` exists with at minimum:
  - [ ] `CONVEX_DEPLOYMENT`
  - [ ] `VITE_CONVEX_URL`
  - [ ] `VITE_CONVEX_SITE_URL`
  - [ ] `VITE_CLERK_PUBLISHABLE_KEY`

### 1.5 `claude` CLI (Claude Code) installed

The CLI reads/writes the macOS Keychain (and `~/.claude.json`) directly
via a native TypeScript module. The only external CLI it depends on is
`claude` (Claude Code itself), invoked interactively for the OAuth flow
during `cvault add`.

- [ ] `which claude` should resolve to your Claude Code binary (e.g.
      `~/.local/bin/claude`).
- [ ] `claude --help` should print usage. Install/upgrade Claude Code if
      missing.

### 1.6 Bun installed

Required to run the CLI source under tests + to build the static binary.

- [ ] `bun --version` reports a version (1.1+ recommended)
- [ ] If missing: `curl -fsSL https://bun.sh/install | bash`

### 1.7 A real (test) Anthropic Max account

Per spec §2 / §15, cvault is single-human / multi-sub. Use a **fresh test Anthropic account** rather than your primary account so the live refresh-token consumption (scenario #15) and the relogin-required test (§5) are reversible.

- [ ] Test Anthropic Max sub created (or borrow a low-stakes Max sub you can re-login on without anxiety)
- [ ] Successfully signed into Claude Code on the dev machine using this test account at least once

### 1.8 A second machine (or VM, or alt user) ready

For [§4 Multi-machine test](#4-multi-machine-test). The second host needs:

- [ ] macOS 13+ (v1 is Mac-first per spec §2 — Linux/Windows untested)
- [ ] `cvault` binary installable (Homebrew tap, raw release tarball, or the binary you built locally)
- [ ] A separate Mac Keychain (a separate Mac, a VM with its own login keychain, or a separate macOS user account)
- [ ] Network reachability to your Convex deployment URL

---

## 2. Smoke tests (5-min full-stack sanity)

End state: dashboard renders, CLI binary builds, login persists session, empty list shows. No subs added yet.

### 2.1 Install + boot dev server

- [ ] In repo root: `yarn install` finishes without errors
- [ ] `yarn dev` starts both Convex dev server and Vite. Watch for:
  - [ ] Convex log line `Convex functions ready!`
  - [ ] Vite log line printing the local URL (typically `http://localhost:3000`; `:5173` if Vite default; treat whatever the script prints as the truth)

### 2.2 Sign in + empty dashboard

- [ ] Open the printed URL in a browser
- [ ] Sign in via the Clerk widget (any auth strategy you have configured)
- [ ] Land on `/dashboard`
- [ ] Confirm the **"no subscriptions yet"** empty state renders (no error toast, no spinner stuck)

### 2.3 Build the CLI binary

In a second terminal:

- [ ] `cd cli && bun build --compile --target=bun-darwin-arm64 ./src/index.ts --outfile cvault`
      (use `bun-darwin-x64` if Intel, `bun-linux-x64` if Linux — but v1 is Mac-first)
- [ ] Confirm a `cli/cvault` binary appears, ~50-100MB
- [ ] `cd cli && ./cvault --version` prints a version string (the value comes from `package.json`)

### 2.4 First login from CLI

- [ ] `./cvault login` in `cli/` directory
- [ ] Browser opens to `/cli/link?...` on the dashboard
- [ ] Click through the confirm step (per security-findings #H1 fix — see §6.1 below)
- [ ] CLI terminal prints "Login successful" and exits 0
- [ ] `ls -la ~/.vault/session.json` shows mode `-rw-------` (i.e. `0600`)
- [ ] `ls -la ~/.vault/` shows mode `drwx------` on the directory itself (i.e. `0700`)
- [ ] Do **not** `cat` the file — its contents are sensitive. If you must inspect, use `wc -c ~/.vault/session.json` (small JSON, ~hundreds of bytes)

### 2.5 Empty list confirms wiring

- [ ] `./cvault list` returns the empty-state rendering (per `cli/src/render/table.ts`) with no error
- [ ] `./cvault status` reports no active sub (matches the lack of an active credential entry on this machine)

If 2.1-2.5 all pass, the rails are connected. Proceed.

---

## 3. Happy-path E2E (~15 min)

Add a real Claude Code subscription, see it flow into Convex, refresh, switch, and remove.

### 3.1 Capture the first sub

- [ ] Open Claude Code on the dev machine and sign into the test Anthropic account (per [§1.7](#17-a-real-test-anthropic-max-account))
- [ ] Verify Claude Code is functional (e.g. ask it `whoami` or use it for one prompt) — this primes the Keychain entry
- [ ] In the cvault `cli/` directory: `./cvault add`
- [ ] CLI spawns `claude` interactively for the OAuth flow, then reads the active credentials + `~/.claude.json` natively to capture the envelope
- [ ] CLI uploads via `api.subscriptions.actions.upsertFromPlaintext` (encrypts server-side under `VAULT_AES_KEY`)
- [ ] CLI prints "Added <email> as slot 1" or similar success line, exits 0

### 3.2 Dashboard reflects the new sub

- [ ] Refresh the browser tab on `/dashboard`
- [ ] One sub card appears with the test account's email, slot 1, no usage bars yet (cron polls every 5 min — be patient)
- [ ] Card shows `expiresAt` countdown (typically 8 hours from `add` time per Anthropic)

### 3.3 Usage bars populate

- [ ] Wait up to 5 minutes for the `pollUsage` cron tick (or trigger via Convex dashboard manually if you don't want to wait — see §7.5 below)
- [ ] Refresh dashboard. The card now shows:
  - [ ] 5h utilization bar (a percentage 0-100)
  - [ ] 7d utilization bar (a percentage 0-100)
  - [ ] `lastRefreshedAt` timestamp (set during `add`)

### 3.4 Force Refresh from dashboard

This is the **post-fix** verification — pre-fix the button was a `console.warn` placeholder per IMPLEMENTATION_NOTES (frontend handoff #3) and scenario #9. After the fix-builder lands the wiring, the button should call `api.subscriptions.actions.requestRefresh`.

- [ ] Click the **Force Refresh** button on the sub card
- [ ] Button enters disabled/loading state briefly
- [ ] Within ~1-2 seconds the card's `lastRefreshedAt` updates to "just now" (live-query reactivity)
- [ ] No error toast / red badge

### 3.5 CLI list mirrors the dashboard

- [ ] `./cvault list` prints a table with: slot, email, label (empty), 5h%, 7d%, expires (relative or ISO), last refresh, active marker
- [ ] The active marker (e.g. `•`) appears next to slot 1 (the only sub)

### 3.6 Switch (single-sub edition)

If you only have one sub, switching is a no-op-ish exercise but still proves the pipeline. Otherwise skip ahead to 3.7 to add a second sub first.

- [ ] `./cvault switch 1`
- [ ] CLI calls `api.subscriptions.actions.pullForSwitch`
- [ ] Hash compare: matches the local `~/.vault/last-hash-{email}.txt` if present (no re-import); mismatches → `importEnvelope` writes Keychain + `~/.claude.json`
- [ ] On native, `switchTo` is a no-op — the active credential is already whatever was just imported
- [ ] No error output; exit 0
- [ ] `./cvault status` confirms slot 1 is active

### 3.7 Add a second sub (optional but recommended)

If you only have one Anthropic test account, skip this and use the multi-machine test ([§4](#4-multi-machine-test)) to exercise switching.

- [ ] In Claude Code, log out and log in with a _second_ test Anthropic account
- [ ] `./cvault add` — should land as slot 2
- [ ] Dashboard now shows two cards
- [ ] `./cvault list` shows both subs

### 3.8 Switch between subs

- [ ] `./cvault switch 1` then `./cvault switch 2` (or vice versa)
- [ ] Each call: pull-on-use, hash compare, import if mismatch (then `switchTo` is a no-op since the imported sub is already active)
- [ ] After each switch: `./cvault status` reflects the new active slot
- [ ] Mac Keychain reflects the swap (verify by opening Keychain Access → search for "Claude Code-credentials" → the active entry has the right account email metadata)

### 3.9 CLI manual refresh

This is **post-fix** territory — pre-fix `cvault refresh` was broken because `refreshOAuthToken` was internal-only. The fix exposed it as `requestRefresh` per IMPLEMENTATION_NOTES backend handoff #3.

- [ ] `./cvault refresh 1` (or `./cvault refresh <email>`)
- [ ] CLI calls `api.subscriptions.actions.requestRefresh`
- [ ] Backend acquires the lease, hits Anthropic, commits new tokens, releases lease, inserts a `refreshLog` row
- [ ] CLI prints success
- [ ] Dashboard's `lastRefreshedAt` updates within ~1s (live query)

### 3.10 Soft remove

- [ ] `./cvault remove 1` (or use the dashboard's Remove button)
- [ ] CLI calls `api.subscriptions.mutations.softRemove` (sets `removedAt`) then natively clears the Keychain entry + `oauthAccount` slice in `~/.claude.json`
- [ ] `./cvault list` no longer shows slot 1
- [ ] Dashboard card disappears from `/dashboard` (filtered out by `removedAt`)
- [ ] In Convex dashboard, the row still exists in the `subscriptions` table — it's a soft delete (the hard-delete cron is deferred per scenario plan §9)

---

## 4. Multi-machine test

Pull-on-use across two machines is the headline feature. This validates that adding on machine 1 + sync on machine 2 results in the same Keychain state.

### 4.1 Bootstrap machine 2

On the second machine (per [§1.8](#18-a-second-machine-or-vm-or-alt-user-ready)):

- [ ] Install the `cvault` binary (Homebrew tap if published, otherwise scp the local build or download from GitHub Releases)
- [ ] If you copied the raw binary outside Homebrew: `xattr -d com.apple.quarantine ./cvault` (per IMPLEMENTATION_NOTES CLI handoff §macOS codesigning)
- [ ] `./cvault --version` prints version (proves Gatekeeper is happy)
- [ ] `./cvault login` opens browser, sign in **as the same Clerk user**, callback hits `127.0.0.1:<port>`
- [ ] `~/.vault/session.json` exists, mode 0600

### 4.2 First-time bulk pull

- [ ] On machine 2: `./cvault sync --all`
- [ ] CLI calls `GET /api/cli/sync` (the bundle endpoint per spec §5)
- [ ] Each sub from Convex is decrypted server-side and returned in a single response
- [ ] CLI imports each natively (writes Keychain + `~/.claude.json`), and writes `~/.vault/last-hash-<email>.txt` per sub
- [ ] `./cvault list` on machine 2 shows the same subs that machine 1 has
- [ ] On machine 2 the Keychain entry "Claude Code-credentials" reflects the LAST imported sub (since native has one active credential at a time)

### 4.3 Switch a sub previously added on machine 1

- [ ] On machine 2: `./cvault switch <slot>` for a sub you originally added from machine 1
- [ ] First switch on machine 2 may show "imported" if the local hash file from §4.2 didn't capture the latest content (rare; typically the hashes match post-sync)
- [ ] Subsequent switches are hash-match short-circuits (per scenario #4)
- [ ] Verify the active account in Keychain matches expectation
- [ ] Machine 1's `./cvault status` does **not** change — switches are local to each machine

### 4.4 Add a sub on machine 1, immediately use on machine 2

- [ ] On machine 1: log into a _new_ Anthropic test account in Claude Code, run `./cvault add`
- [ ] On machine 2 (without re-running sync): `./cvault list` should show the new sub (the dashboard query is live; the CLI list query is per-call)
- [ ] On machine 2: `./cvault switch <new-slot>`
- [ ] CLI hash-mismatches (machine 2 has no local hash for this email yet), pulls from Convex, imports, switches
- [ ] Verify the new sub is active on machine 2 — no manual `sync --all` was needed

### 4.5 Audit feed reflects both machines

- [ ] On the dashboard, navigate to `/dashboard/audit`
- [ ] Recent rows include actions from both Clerk session IDs (one per machine)
- [ ] If you click into `/dashboard/machines`, you should see two distinct active sessions

---

## 5. Failure-mode tests

Map to scenario plan #6, #7, #8, #12, #13, #14. These intentionally break things to verify the system degrades gracefully rather than silently doing the wrong thing.

### 5.1 Force a token to "expire" (scenario #6 manual variant)

Without burning a real refresh token, you can simulate the auto-refresh behavior:

- [ ] Open the Convex dashboard for your dev deployment → **Data** tab
- [ ] Open the `subscriptions` table
- [ ] Pick the test sub and edit `expiresAt` to a value in the past (e.g. `Date.now() - 1000`)
- [ ] On the CLI: `./cvault switch <slot>`
- [ ] Watch the Convex logs (dashboard → **Logs**) for `refreshOAuthToken` invocation
- [ ] Sub row now has `expiresAt` ~8h in the future, refreshed ciphertext, fresh `lastRefreshedAt`
- [ ] One new row in `refreshLog` with `triggeredBy: 'onUse'` (or `'manual'` depending on path) and `outcome: 'success'`

### 5.2 Simulate refresh-token death → relogin badge (scenario #8)

The cleanest way to simulate without burning a real Anthropic refresh token:

- [ ] In the Convex dashboard, edit the test sub: set `refreshExpiresAt` to a past timestamp (e.g. `Date.now() - 1000`) **and** set `expiresAt` to `Date.now() - 1000` so the next access triggers refresh
- [ ] Either trigger the cron manually (via Convex dashboard → **Functions** → run `internal.subscriptions.crons.refreshExpiringTokens`) or wait for the 10-min tick
- [ ] If `refreshExpiresAt < now`, Anthropic will return 401 invalid_grant (or 400 — the backend treats both as `reloginRequired` per IMPLEMENTATION_NOTES "Spec deviations")
- [ ] Refresh the dashboard; the card now shows the **`⚠ relogin required`** badge
- [ ] `./cvault list` shows a `⚠ relogin` indicator on that row
- [ ] One new `refreshLog` row with `outcome: 'reloginRequired'`

### 5.3 Tamper with ciphertext → "creds corrupt" (scenario #13)

- [ ] In the Convex dashboard `subscriptions` table, edit the test sub's `ciphertext` field — flip one byte (e.g. change the last byte's value)
- [ ] On the CLI: `./cvault switch <slot>`
- [ ] Expected: action throws because GCM auth-tag verification fails on `decrypt`
- [ ] CLI surfaces an error mentioning "creds corrupt" or "re-add" per spec §10
- [ ] **Verify no plaintext leaks** in the error message — search for `sk-ant-`, `accessToken`, `refreshToken` in the CLI's stderr; should not appear

> **Note (security finding M1):** The current backend does NOT wrap `decrypt()` in try/catch in `refreshOAuthToken` and `fetchUsageForSub` (per security-findings.md M1). After the fix-builder lands the M1 patch, also verify:
>
> - [ ] `refreshLog` row inserted with `outcome: 'failure'` and a redacted error
> - [ ] Sub's `refreshLeaseUntil` is not stuck (lease released cleanly)

### 5.4 Network down → offline degradation (scenario #12)

- [ ] On the CLI machine, disable network access to the Convex deployment. Easiest: turn off Wi-Fi briefly, or `sudo route add -host <convex-cloud-IP> 127.0.0.1` (then `route delete` after)
- [ ] `./cvault switch <slot>`
- [ ] Expected: CLI prints `⚠ offline — using local cache` (or similar wording per `cli/src/commands/switch.ts`)
- [ ] CLI falls back to a local `switchTo` (a no-op on native since the active credential is whatever was last imported) — the previously-active sub stays active
- [ ] Re-enable network. `./cvault switch` to a different slot — should pull-on-use against Convex and behave normally again

### 5.5 Refresh log redaction (scenario #14)

- [ ] In Convex dashboard `refreshLog` table, scroll through recent rows
- [ ] For any row with `outcome: 'failure'` or `'reloginRequired'`, inspect `error`:
  - [ ] No `sk-ant-oat01-...` substrings
  - [ ] No `sk-ant-ort01-...` substrings
  - [ ] If a token-shaped string was in the original Anthropic response body, it should appear as `<redacted>`
- [ ] Same check on the Convex **Logs** tab — search for `sk-ant-` across recent log lines; expect zero hits

### 5.6 (Optional) Refresh race protection (scenario #7)

This requires concurrent refresh attempts. Manually:

- [ ] Open two terminals
- [ ] In each: prepare `./cvault refresh <slot>` but don't hit enter yet
- [ ] In Convex dashboard, set the sub's `expiresAt` to past
- [ ] Hit enter in both terminals as close to simultaneously as possible
- [ ] Expected: only one Anthropic refresh call (verify in Convex logs — only one `refreshOAuthToken` should have called Anthropic; the other should have lost the lease and aborted silently)
- [ ] `refreshLog` has exactly one new `outcome: 'success'` row, not two
- [ ] Sub's `refreshLeaseHolder` is undefined (lease cleanly released)

---

## 6. Security smoke (post-fix verification)

After the fix-builder lands the security review patches, walk through these verifications. Each maps to a finding in [security-findings.md](research/security-findings.md).

### 6.1 Open redirect fix (H1)

The pre-fix `/cli/link` route accepted any URL in the `redirect` search param, allowing a phishing flow that leaks a freshly minted Clerk sign-in token to an attacker-controlled host.

- [ ] In the browser (signed in as your dashboard user), navigate to:
  ```
  <FRONTEND_URL>/cli/link?redirect=https://attacker.example.com&state=xyz
  ```
- [ ] Expected: page renders an error like "invalid redirect host" (or refuses to render the auto-POST button)
- [ ] No automatic POST to `attacker.example.com` happens
- [ ] Try a valid redirect: `<FRONTEND_URL>/cli/link?redirect=http://127.0.0.1:54321/callback&state=xyz` — should accept, render the confirm step, POST to `127.0.0.1:54321` only after click
- [ ] Try `http://[::1]:54321/callback` — should also be accepted (both loopback v4 and v6)
- [ ] Try `https://127.0.0.1:54321/callback` — depends on the fix's exact rules; per the recommendation it should reject `https:` for loopback (loopback uses `http:`)

### 6.2 Cross-tenant revoke fix (verifies §7 user isolation)

A user must not be able to revoke another user's Clerk session via `api.cli.actions.revokeSession`.

- [ ] Create a second Clerk user (e.g. via the Clerk dashboard or a fresh sign-up)
- [ ] Sign that second user into a separate browser profile / private window
- [ ] Note the second user's Clerk session ID (visible in `/dashboard/machines` for them, or via Convex dashboard's `machineActivity` table filtering by their `userId`)
- [ ] As user A (your primary), open the Convex dashboard → **Functions** → `api.cli.actions.revokeSession` → run with `{ clerkSessionId: "<user-B-session-id>" }`
- [ ] Expected: action rejects with an ownership / not-found error
- [ ] User B's session is **not** revoked (verify on user B's dashboard)
- [ ] Then verify the legitimate path works: revoke one of your _own_ sessions; expected to succeed and the revoked machine's next CLI call returns 401 → triggers re-auth flow

### 6.3 Force Refresh button is wired (post-fix)

Pre-fix, the dashboard's Force Refresh button was a `console.warn` placeholder. The fix wires it to `useAction(api.subscriptions.actions.requestRefresh)`.

- [ ] On the dashboard, click Force Refresh on a sub card
- [ ] Open browser devtools → Network tab; observe a Convex action call (look for `requestRefresh` in the request payload)
- [ ] No `console.warn` appears in the JS console with a "PENDING" or "TODO" message
- [ ] The card's `lastRefreshedAt` updates after the action resolves

### 6.4 `cvault refresh <slot>` works (post-fix)

Pre-fix, `refresh` failed with "Could not find function" because `refreshOAuthToken` was `internalAction`-only.

- [ ] `./cvault refresh 1` returns success
- [ ] The action invoked is `api.subscriptions.actions.requestRefresh` (per the rename documented in IMPLEMENTATION_NOTES backend handoff #3)
- [ ] If the CLI source still references `refreshOAuthTokenForUser`, that's a stale `// PENDING:` marker — search `cli/src` for `PENDING:` and verify those have been resolved post-fix

### 6.5 (Optional) Other findings to spot-check

| Finding                                          | Sev | Spot check                                                                                                                     |
| ------------------------------------------------ | --- | ------------------------------------------------------------------------------------------------------------------------------ |
| M1 — decrypt try/catch                           | Med | Already covered by §5.3                                                                                                        |
| M2 — `Promise.allSettled` in crons               | Med | Inspect `convex/subscriptions/crons.ts` source post-fix; one bad sub doesn't fail the whole cron run                           |
| M3 — bulk `/api/cli/sync` rate limit + audit row | Med | After fix, run `./cvault sync --all` then check `machineActivity` for a row with `action: 'pull'` and the bulk-sync session id |
| M4 — `machineActivity` rows for all mutations    | Med | After `./cvault add` / `remove` / `refresh`, a corresponding row should appear in `machineActivity` with the right action      |
| L1 — `getClerkSessionId` helper                  | Low | Code review only; no UI surface                                                                                                |
| L4 — token regex prefix class                    | Low | If Anthropic ever issues uppercase-prefixed tokens, redaction must still apply                                                 |

---

## 7. Convex dashboard inspection

Sanity-check what's in the database. Open <https://dashboard.convex.dev> → your dev deployment.

### 7.1 `subscriptions` table

- [ ] Open **Data** tab → `subscriptions`
- [ ] Each row's `ciphertext` field is shown as `bytes` (hex-encoded blob), **not** plaintext JSON
- [ ] Each row has a non-zero `nonce` (12 bytes)
- [ ] `email`, `slot`, `expiresAt`, `lastRefreshedAt` are populated
- [ ] No row has `accessToken`, `refreshToken`, or any `sk-ant-...` string in any visible field
- [ ] Soft-removed rows have `removedAt` set (filtered out of `listForUser` query)

### 7.2 `refreshLog` table

- [ ] Open `refreshLog`
- [ ] Recent rows have `triggeredBy` ∈ {`cron`, `manual`, `onUse`}
- [ ] `outcome` ∈ {`success`, `failure`, `reloginRequired`}
- [ ] `error` field (when present): no `sk-ant-` substring; redacted to `<redacted>` per the regex in `convex/subscriptions/redact.ts`

### 7.3 `machineActivity` table

- [ ] Open `machineActivity`
- [ ] Rows for `action: 'pull'` (per `pullForSwitch`) — verify post-fix-builder's M4 fix that other actions also write rows: `add` (from `upsertFromPlaintext`), `remove` (from `softRemove`), `refresh` (from `requestRefresh`), `switch` if implemented per IMPLEMENTATION_NOTES "Spec deviations" #2
- [ ] `clerkSessionId` is a real Clerk-shape `sess_...` string (not `'unknown-session'` for current sessions)
- [ ] `ipHash` (when set): 8-char hex prefix, never a raw IP. Per security finding M5, this may currently be undefined for all rows — verify post-fix if M5 was patched

### 7.4 Logs

- [ ] Open **Logs** tab
- [ ] Filter to recent: search for `sk-ant-` — should return zero results
- [ ] Search for `console.error` from your refresh / decrypt failure tests; verify no plaintext leak
- [ ] Cron invocations (`refreshExpiringTokens`, `pollUsage`) show `Promise.allSettled` (post-fix M2) — one failure does not surface as a failed cron run

### 7.5 Manually trigger crons (handy for testing)

- [ ] **Functions** tab → search `internal.subscriptions.crons.refreshExpiringTokens` → click **Run** with `{}`
- [ ] Same for `internal.subscriptions.crons.pollUsage`
- [ ] Watch the **Logs** tab for the resulting `refreshOAuthToken` / `fetchUsageForSub` invocations

---

## 8. Known-deferred items the user should NOT expect to work

Per spec §14 + IMPLEMENTATION_NOTES "Open backend issues" + scenario plan §9. Don't file these as bugs:

- [ ] **Encrypted backup / disaster recovery** — `cvault export --encrypted backup.json` is not implemented. Key loss = unrecoverable in v1.
- [ ] **Slack / email notifications on refresh failure** — no notification surface in v1.
- [ ] **Encryption key rotation tooling** — `VAULT_AES_KEY` cannot be rotated without manually re-adding every sub.
- [ ] **Per-user mutation rate limiting** — deferred to v2 per spec §12. (Verify whether the M3 fix-builder added any rate limit on `/api/cli/sync` specifically; if so, that's a partial fix.)
- [ ] **`cvault watch` daemon** — no background mode; pull-on-use only per spec §2.
- [ ] **Multi-org / team sharing** — explicitly excluded per spec §2 (ToS reasons). The `organizations` / `organizationMembers` Blueprint tables and webhook handlers were deleted in commit 4d9c55c; bringing them back is a v2 task.
- [ ] **Linux / WSL** — supported by the native module (file-based credentials at `~/.claude/.credentials.json`) but untested in v1's manual testing harness.
- [ ] **Windows** — `cvault` throws `PlatformUnsupportedError` on `process.platform === 'win32'`. Tracked as a follow-up issue.
- [ ] **Hard-delete cron after 30d** — deferred per scenario plan §9. Soft-removed rows stay forever in v1.
- [ ] **Live Anthropic refresh scenario test** — `convex/__scenarios__/liveAnthropicRefresh.scenario.test.ts` is gated on `VAULT_TEST_REFRESH_TOKEN` and consumes the token on each run. Skip unless explicitly running the live suite.
- [ ] **Anthropic API contract drift** — no integration test against the real refresh endpoint runs by default. If Anthropic changes their wire format, mocks won't catch it (per security finding L2).

---

## 9. What "passes" looks like

Bare minimum for v1 acceptance:

**Functional:**

- [ ] Can sign in via dashboard, see empty state
- [ ] Can build CLI binary, run `./cvault login`, persist `~/.vault/session.json` with mode 0600
- [ ] Can `./cvault add` a real Anthropic sub; row appears in Convex `subscriptions` with encrypted ciphertext (never plaintext)
- [ ] Dashboard shows the sub card with usage bars within 5 min of add (cron tick)
- [ ] `./cvault list` matches the dashboard
- [ ] `./cvault switch <slot>` succeeds; Mac Keychain reflects the new active account
- [ ] `./cvault refresh <slot>` succeeds (post-fix); `lastRefreshedAt` updates live
- [ ] Force Refresh button on dashboard works (post-fix); calls `requestRefresh`
- [ ] `./cvault remove <slot>` soft-removes; sub disappears from list + dashboard
- [ ] `./cvault sync --all` on a fresh second machine pulls all subs and imports them
- [ ] Switching on machine 2 to a sub added on machine 1 works without manual sync

**Failure-mode:**

- [ ] Forcing `expiresAt` to past triggers refresh on next use; dashboard reflects new state
- [ ] Forcing `refreshExpiresAt` to past surfaces the `⚠ relogin required` badge
- [ ] Tampered `ciphertext` produces a clear "creds corrupt — re-add" error with no plaintext leak
- [ ] Offline → CLI degrades to a local `switchTo` no-op with `⚠ offline` warning (active credentials remain whatever was last imported)

**Security (post-fix):**

- [ ] `/cli/link?redirect=<external>` rejects non-loopback URLs
- [ ] Cross-tenant `revokeSession` rejects with ownership error
- [ ] No `sk-ant-` substrings appear in `refreshLog.error` or Convex logs
- [ ] All `subscriptions.ciphertext` rows are bytes, never plaintext
- [ ] `machineActivity` records every authenticated mutation/action (post-fix M4)

If all of the above tick, v1 is done.

---

## 10. Reporting bugs

When something fails, capture **all** of the following before filing the report — this saves a round-trip to ask for missing data:

### 10.1 The exact CLI invocation

- [ ] Full command including all flags, e.g. `./cvault switch 2 --verbose`
- [ ] Working directory at time of run
- [ ] Output (stdout + stderr) — copy verbatim, not paraphrased
- [ ] Exit code (`echo $?` immediately after the failing command)

### 10.2 Dashboard state

- [ ] Browser URL at time of failure
- [ ] Screenshot of the dashboard card (or the relevant page) showing the broken state
- [ ] Browser devtools → **Console** tab — copy any errors / warnings
- [ ] Browser devtools → **Network** tab — for any failed requests, capture the request URL, method, status, and request/response payloads (**redact tokens** before sharing)

### 10.3 Convex log

- [ ] Open the Convex dashboard → **Logs** tab
- [ ] Filter to the time window of the failure (give yourself 60 seconds of slack on each side)
- [ ] Copy the relevant log lines verbatim
- [ ] If a function failed, note the function name and the error message

### 10.4 Local session file metadata (do NOT share contents)

- [ ] `ls -la ~/.vault/session.json` — share the line (mode + size + mtime; the path is not sensitive)
- [ ] `wc -c ~/.vault/session.json` — byte count
- [ ] **Do not paste the file's contents.** It contains a Clerk session token that grants access to your account.

### 10.5 Environment

- [ ] OS + version (`sw_vers` on macOS)
- [ ] `bun --version`
- [ ] `claude --version` (Claude Code CLI)
- [ ] CLI binary version: `./cvault --version`
- [ ] Convex deployment slug (visible in `.env.local` or `npx convex env list`)

Bundle the above into a bug report (Slack DM, ticket, GitHub issue — whatever your workflow is). Avoid pasting any token-shaped string. If you accidentally paste one, rotate `VAULT_AES_KEY` is **not** sufficient — you must re-add every affected sub (key rotation isn't supported in v1 per spec §6).
