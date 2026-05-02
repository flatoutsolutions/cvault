# cvault — Centralized Claude Code Credential Vault

**Date:** 2026-05-02
**Status:** Design approved, awaiting implementation plan
**Owner:** Stefan (single user, multi-machine)

---

## 1. Problem

Claude Code stores its OAuth credentials in a single Mac Keychain entry per machine (`Claude Code-credentials`). Switching between multiple paid Claude subscriptions on one machine is solved locally by [`claude-swap`](https://github.com/realiti4/claude-swap) (multi-account switcher backed by Keychain + `~/.claude-swap-backup/`). `claude-swap` does not solve:

1. **Cross-machine sync** — only manual `--export` / `--import` between hosts.
2. **OAuth refresh automation** — expired access tokens require re-running `--add-account`. Refresh tokens that themselves expire (~6 months) require full re-login.
3. **Centralized usage visibility** — Anthropic's `/api/oauth/usage` endpoint is queried per-machine; no aggregated view.
4. **Audit trail** — no record of which machine switched to which account when.

We want one source of truth (Convex) holding encrypted credentials, with N machines pulling on demand and auto-refresh handled server-side.

---

## 2. Scope

### In scope (v1)

- One human (the owner) with multiple Anthropic Max subscriptions across multiple Mac machines.
- CLI commands: `login`, `add`, `list`, `switch`, `refresh`, `remove`, `status`, `sync`.
- Web dashboard: subscription list with live usage bars, force-refresh, machine list, audit log.
- Server-side cron refresh of expiring access tokens.
- Server-side cron poll of Anthropic usage endpoint.
- AES-256-GCM at-rest encryption with master key in Convex env var.
- Clerk-based auth across CLI + dashboard.

### Out of scope (v1)

- Multi-human team sharing of subscriptions (violates Anthropic ToS — flagged + rejected during brainstorming).
- Encrypted backup / disaster recovery export.
- Slack / email notifications on refresh failure.
- Linux / Windows tested support (Mac-first in v1; `claude-swap` already supports both other platforms via Cred Manager / XDG file backend, so the wrapper should function — just not validated in v1).
- Background daemon on machines (`vault watch`) — pull-on-use only in v1.
- Encryption key rotation tooling (manual re-add required if key lost).

### Anthropic ToS note

Anthropic Max / Pro subscriptions are licensed per individual. v1 design serves a single human across that human's own multiple subscriptions and machines. Sharing one paid subscription across multiple humans is explicitly not supported and would risk account ban.

---

## 3. Architecture

```
┌──────────────────── CONVEX CLOUD ─────────────────────┐
│  Tables: users (existing), subscriptions, refreshLog, │
│          machineActivity                              │
│  Functions: queries, mutations, actions, crons        │
│  HTTP: /api/cli/sync                                  │
│  Crons: refreshExpiringTokens (10m), pollUsage (5m)   │
└────────────────┬────────────────────┬─────────────────┘
                 │ Clerk JWT          │ Clerk JWT
       ┌─────────┴────────┐  ┌────────┴──────────┐
       │   MACHINE 1      │  │  MACHINE 2        │
       │   vault CLI      │  │  vault CLI        │
       │     │            │  │     │             │
       │   claude-swap    │  │  claude-swap      │
       │     │            │  │     │             │
       │   Mac Keychain   │  │  Mac Keychain     │
       └──────────────────┘  └───────────────────┘

┌──────────── CLOUDFLARE PAGES (TanStack Start) ────────┐
│  /dashboard, /dashboard/audit, /dashboard/machines    │
│  /dashboard/settings                                  │
└───────────────────────────────────────────────────────┘
```

**Source of truth:** Convex DB. Mac Keychain is a local cache rehydrated on demand. `claude-swap` continues to own all Mac Keychain reads/writes — `vault` shells to it.

**Trust model:** Convex sees plaintext refresh tokens (must, to refresh server-side). Defense-in-depth via AES-GCM ciphertext at rest. Clerk JWT scopes everything to one human.

**Stack:** Blueprint 2.0 (TanStack Start + Convex + Clerk + Cloudflare Pages + GitHub Actions).

---

## 4. Convex schema

### Existing (Blueprint, unchanged)

- `users` — `{externalId, name, primaryEmail, otherEmails, imageUrl}`, indexed `byExternalId`.
- `organizations`, `organizationMembers` — present, unused in v1.

### New

#### `convex/subscriptions/schema.ts`

```ts
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const subscriptionsSchema = defineTable({
  userId: v.id('users'),
  email: v.string(), // Anthropic account email
  slot: v.number(), // 1..N per user, ordering
  label: v.optional(v.string()), // user nickname
  ciphertext: v.bytes(), // AES-256-GCM(claudeAiOauth JSON)
  nonce: v.bytes(), // 12-byte GCM nonce
  expiresAt: v.number(), // accessToken expiry, ms epoch
  refreshExpiresAt: v.optional(v.number()),
  subscriptionType: v.string(), // "max" | "pro"
  rateLimitTier: v.string(),
  lastRefreshedAt: v.number(),
  refreshLeaseHolder: v.optional(v.string()),
  refreshLeaseUntil: v.optional(v.number()),
  usage5h: v.optional(
    v.object({
      pct: v.number(),
      resetsAt: v.number(),
      fetchedAt: v.number(),
    })
  ),
  usage7d: v.optional(
    v.object({
      pct: v.number(),
      resetsAt: v.number(),
      fetchedAt: v.number(),
    })
  ),
  removedAt: v.optional(v.number()),
})
  .index('byUserAndSlot', ['userId', 'slot'])
  .index('byUserAndEmail', ['userId', 'email'])
  .index('byExpiry', ['expiresAt'])
```

#### `convex/refreshLog/schema.ts`

```ts
export const refreshLogSchema = defineTable({
  userId: v.id('users'),
  subscriptionId: v.id('subscriptions'),
  triggeredBy: v.union(v.literal('cron'), v.literal('manual'), v.literal('onUse')),
  outcome: v.union(v.literal('success'), v.literal('failure'), v.literal('reloginRequired')),
  error: v.optional(v.string()),
  at: v.number(),
})
  .index('bySubscriptionAndAt', ['subscriptionId', 'at'])
  .index('byUserAndAt', ['userId', 'at'])
```

#### `convex/machineActivity/schema.ts`

```ts
export const machineActivitySchema = defineTable({
  userId: v.id('users'),
  clerkSessionId: v.string(),
  action: v.union(v.literal('switch'), v.literal('add'), v.literal('pull'), v.literal('remove'), v.literal('refresh')),
  subscriptionId: v.optional(v.id('subscriptions')),
  at: v.number(),
  ipHash: v.optional(v.string()), // SHA-256, 8-char prefix
})
  .index('byUserAndAt', ['userId', 'at'])
  .index('byUserAndSessionAndAt', ['userId', 'clerkSessionId', 'at'])
```

### Index rationale

| Index                                   | Query supported                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `subscriptions.byUserAndSlot`           | List user's subs sorted by slot; switch by slot; prefix-only `eq(userId)` queries |
| `subscriptions.byUserAndEmail`          | Switch by email; dedup check on `add`                                             |
| `subscriptions.byExpiry`                | Cron scan for expiring tokens (`lt(expiresAt, now+15m)`)                          |
| `refreshLog.bySubscriptionAndAt`        | Per-sub history in audit UI                                                       |
| `refreshLog.byUserAndAt`                | Combined audit feed                                                               |
| `machineActivity.byUserAndAt`           | Recent activity dashboard                                                         |
| `machineActivity.byUserAndSessionAndAt` | Per-machine drilldown                                                             |

`removedAt` filtering happens in handlers (low cardinality of soft deletes does not justify dedicated index). Nested `usage*.fetchedAt` is not indexable; the per-user fanout for usage cron is acceptable at < 20 subs realistic.

---

## 5. Convex functions

Per Blueprint convention, each domain folder owns its `queries.ts`, `mutations.ts`, `actions.ts`, `crons.ts`.

### `convex/subscriptions/queries.ts`

- `listForUser` — returns subs for current Clerk user, excludes `removedAt`, strips ciphertext + nonce.
- `getMetaByEmail(email)` — used by `cvault status`. Excludes ciphertext.

(No plaintext-returning queries — Convex queries are read-only and reactive; they cannot trigger refresh. All plaintext access is through actions.)

### `convex/subscriptions/mutations.ts`

- `upsert({email, plaintextBlob, slot?})` — encrypts blob, conflict-checks via `byUserAndEmail`, assigns next free slot if new.
- `softRemove({slot|email})` — sets `removedAt`.
- `rename({slot|email, label})` — patches label only.
- `tryAcquireRefreshLease({subId, holderToken})` — atomic CAS for refresh race protection.
- `releaseRefreshLease({subId, holderToken})` — clears lease iff holder matches.
- `commitRefreshedTokens({subId, ciphertext, nonce, expiresAt, refreshExpiresAt?, lastRefreshedAt})` — internal mutation called from `refreshOAuthToken` action after successful Anthropic call.

### `convex/subscriptions/actions.ts`

- `pullForSwitch({slotOrEmail})` — public action used by `cvault switch`. Loads sub, if `expiresAt < now+5min` calls `refreshOAuthToken` first, decrypts, returns `{email, slot, plaintextBlob, contentHash}`.
- `refreshOAuthToken({subId, triggeredBy})` — acquires lease via mutation, decrypts refresh_token, POSTs Anthropic refresh endpoint, calls `commitRefreshedTokens` mutation, releases lease via mutation, inserts `refreshLog`.
- `fetchUsageForSub({subId})` — decrypts accessToken, GETs `https://api.anthropic.com/api/oauth/usage`, patches `usage5h`/`usage7d` via internal mutation.

### `convex/subscriptions/crons.ts`

- `refreshExpiringTokens` every 10 min — scans `byExpiry`, schedules `refreshOAuthToken` for each.
- `pollUsage` every 5 min — fanout `fetchUsageForSub` per active sub per user.

### `convex/subscriptions/http.ts`

- `/api/cli/sync` — bundle endpoint returning all subs' plaintext for `vault sync --all` (single-call bootstrap on new machine).

All cron-scheduled functions are `internalAction` (per Convex essentials: never schedule public `api.*`).

---

## 6. Encryption envelope

- Master key `VAULT_AES_KEY`, 32 bytes base64, set once via `npx convex env set VAULT_AES_KEY <key>`.
- Per-row write: generate fresh 12-byte nonce, AES-256-GCM encrypt JSON-stringified `claudeAiOauth` blob.
- Plaintext lives only inside Convex action runtime + on machine after pull.
- Plaintext NEVER stored in `machineActivity` or `refreshLog`. `refreshLog.error` strips OAuth-token-shaped substrings via regex `sk-ant-[a-z]+\d+-[A-Za-z0-9_-]{20,}` → `<redacted>`.
- v1: key loss = unrecoverable; manual re-add of every subscription required. v2: dual-key envelope + cron rewrap (deferred).

---

## 7. CLI

### Distribution

- **Language: TypeScript on Bun runtime** (pivot from Python on 2026-05-02 — see decision log §15)
- **Build:** `bun build --compile --target=bun-darwin-arm64 ./src/index.ts --outfile cvault` produces a single static binary; same for `darwin-x64` and `linux-x64`
- **Distribution channels:**
  - Homebrew tap (primary): `brew tap stefan/cvault && brew install cvault`
  - GitHub Releases (binaries by triple)
  - `bunx cvault` for users who already have Bun
- **Source layout:** `cli/` subfolder of the cvault monorepo; shares `convex/_generated/` types with the backend via TS path alias for end-to-end type safety
- **Binary name:** `cvault` (avoids Hashicorp `vault` PATH conflict)
- **Config dir:** `~/.vault/` (`session.json`, `last-hash-{email}.txt`, `config.toml`), mode 0600 files / 0700 dir
- **Reuses:**
  - `@clerk/backend` for JWT verification helpers + Backend API calls
  - `convex/browser` (`ConvexHttpClient`) for queries/mutations/actions
  - `Bun.spawn` for subprocess wrapping `claude-swap`
  - Argument parser: `commander` (mature, type-friendly) — re-evaluate vs `citty` during impl

### Commands

| Command                       | Purpose                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `cvault login`                | Browser → Clerk → persists session JSON                                                                         |
| `cvault add`                  | Captures current Claude Code login via `claude-swap --add-account` + `--export -`, uploads to Convex            |
| `cvault list`                 | Renders table from Convex query: slot, email, label, 5h%, 7d%, expires, last refresh, active marker             |
| `cvault switch <slot\|email>` | Pull-on-use: fetch from Convex, hash-compare, `claude-swap --import -` if newer, then `claude-swap --switch-to` |
| `cvault refresh [slot]`       | Triggers Convex `refreshOAuthToken` action manually                                                             |
| `cvault remove <slot\|email>` | Soft-deletes in Convex, runs `claude-swap --remove-account` locally                                             |
| `cvault status`               | Combines local `claude-swap --status` + Convex view for active sub                                              |
| `cvault sync --all`           | Bootstrap on new machine: pulls every sub, imports each into Keychain                                           |

### Pull-on-use semantics (`switch`)

1. Convex action `pullForSwitch` — server-side, refreshes if `expiresAt < now+5min`, decrypts, returns `{email, slot, plaintextBlob, contentHash}`.
2. CLI compares server-returned `contentHash` against `~/.vault/last-hash-{email}.txt`. Match → skip import.
3. Mismatch → `claude-swap --import -` with single-account export shape, then update local hash.
4. `claude-swap --switch-to <slot>`.

### Offline degradation

- Convex unreachable → fall back to local `claude-swap --switch-to` directly. Print `⚠ offline — using local cache`.
- `claude-swap` missing → exit with install hint.
- Clerk session expired → trigger browser re-auth, persist new session, retry original command.

---

## 8. Web dashboard (TanStack Start)

| Route                 | Purpose                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/`                   | Redirect to `/dashboard` if authed, else Clerk sign-in                                                             |
| `/dashboard`          | Sub list cards w/ usage bars, expiry, last refresh, relogin badge; per-card actions: Force Refresh, Rename, Remove |
| `/dashboard/audit`    | Merged feed of `refreshLog` + `machineActivity`, filterable                                                        |
| `/dashboard/machines` | Active Clerk sessions w/ last seen, IP hash; "Revoke" calls Clerk API                                              |
| `/dashboard/settings` | Help links, deferred-feature placeholders (rotate key, export backup)                                              |

All Convex calls via authenticated query/mutation wrappers from Blueprint (`authenticatedQuery`, `authenticatedMutation`).

---

## 9. Refresh race protection

OAuth refresh tokens are single-use. Two machines refreshing the same sub simultaneously → only one win, the other's session is permanently broken.

**Mechanism:** `tryAcquireRefreshLease({subId, holderToken})` mutation:

```ts
const sub = await ctx.db.get(subId)
if (sub.refreshLeaseUntil && sub.refreshLeaseUntil > now) {
  return { acquired: false }
}
await ctx.db.patch(subId, {
  refreshLeaseHolder: holderToken,
  refreshLeaseUntil: now + 30_000,
})
return { acquired: true }
```

The `refreshOAuthToken` action calls this first. Loser sleeps 1 second, re-queries the sub (likely freshly rotated by winner), aborts if still expired. Lease auto-releases via TTL.

---

## 10. Error handling

### Convex side

| Failure                                    | Response                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Anthropic refresh 401 (refresh_token dead) | Patch `refreshExpiresAt=now`; log `reloginRequired`; surface in `list` w/ `⚠ relogin` flag |
| Anthropic refresh 5xx / network            | Log `failure`; cron retries next tick; no exponential backoff in v1                        |
| Lease loss                                 | Sleep 1s, re-query; if still expired, log + abort                                          |
| Anthropic usage 429                        | Skip cycle, retry next 5m                                                                  |
| Decrypt failure (GCM auth tag)             | Throw, log error w/ subId; surface as "creds corrupt — re-add"                             |
| Action timeout                             | Lease TTL (30s) auto-expires; next cron picks up                                           |

### CLI side

| Failure                 | Response                                      |
| ----------------------- | --------------------------------------------- |
| Convex unreachable      | Degrade to local `claude-swap`, print warning |
| Stale local Keychain    | Pull-on-use auto-applies before switch        |
| `claude-swap` missing   | Exit w/ install hint                          |
| Clerk session expired   | Browser re-auth, retry                        |
| Empty Keychain on `add` | "log into Claude Code first, then re-run"     |

---

## 11. Testing

### Convex (Vitest + `convex-test`)

- `subscriptions/mutations.test.ts` — upsert / softRemove / rename / lease behavior
- `subscriptions/queries.test.ts` — user isolation, removedAt exclusion, slot ordering, ciphertext stripping
- `subscriptions/refresh.test.ts` — lease CAS, 401 → reloginRequired, 500 → failure, lease released
- `subscriptions/usage.test.ts` — 200 patches cache, 429 skips silently
- `subscriptions/crypto.test.ts` — encrypt/decrypt roundtrip, tampered ciphertext throws, nonce uniqueness
- `crons.test.ts` — schedules only matching subs
- `auth.test.ts` — unauth → 401, cross-user → empty
- `__scenarios__/refreshCycle.scenario.ts` — live cycle against dev deploy, gated on `VAULT_TEST_REFRESH_TOKEN` env

### CLI (Vitest, runs under Bun)

- `cli/src/claudeSwap.test.ts` — subprocess via `Bun.spawn` + JSON parse + missing binary handling
- `cli/src/commands/add.test.ts` — payload assembly via mocked `claude-swap` + mocked Convex client
- `cli/src/commands/switch.test.ts` — hash match skip, mismatch import, offline degrade, expired triggers refresh
- `cli/src/commands/list.test.ts` — table render, active marker, usage rounding
- `cli/src/auth.test.ts` — session persist (mode 0600 enforced), Clerk JWT mint, expired Clerk session triggers re-auth path

Mocking: `VaultClient` interface abstracts Convex calls; `FakeVaultClient` for unit tests. Anthropic `fetch` wrapped in `cli/src/anthropicClient.ts` thin module, mocked via `vi.mock`. `Bun.spawn` mocked via `vi.spyOn(Bun, 'spawn')`.

### Frontend (Vitest + Testing Library)

- `routes/__tests__/dashboard.test.tsx` — renders, usage bars, force-refresh action, relogin warning
- `routes/__tests__/audit.test.tsx` — filters, pagination, sort

### Coverage

- Convex backend: 90%+ (security-critical)
- CLI: 80%+
- Frontend: 70%+

### Not tested

- Anthropic API contract (mocked, scenario test on demand)
- Clerk JWT verification (trusted)
- `claude-swap` internals (vendor)
- AES-GCM correctness (Node crypto trusted; only roundtrip tested)

---

## 12. Security posture

| Layer             | Control                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Auth              | Clerk (TOTP/passkeys per existing Clerk config)                                                                    |
| In-transit        | TLS via Convex Cloud + Cloudflare Pages                                                                            |
| At-rest           | AES-256-GCM, master key in Convex env (not in code)                                                                |
| Logs              | Token-shaped substrings stripped via regex                                                                         |
| CLI session       | Clerk session token in `~/.vault/session.json` (mode 0600), refreshed via Clerk SDK                                |
| IP collection     | SHA-256 hashed, 8-char prefix; raw IP never stored                                                                 |
| Function exposure | All public mutations/queries via Blueprint `authenticatedQuery`/`authenticatedMutation`; cron-only via `internal*` |
| Rate limit        | Clerk sign-in throttling; per-user mutation rate limit deferred to v2 (convex-helpers)                             |

---

## 13. Deployment

- Convex: dev via `npx convex dev`, prod deploy `vault-prod`; env vars (`VAULT_AES_KEY`, `CLERK_*`) set via `convex env set`.
- Frontend: Cloudflare Pages via Blueprint's existing GitHub Actions workflow.
- CLI: PyPI publish via GitHub Actions (`pypi-publish` action), semver tags.
- Secrets: Convex deploy key + Cloudflare API token set in GitHub repo secrets.

---

## 14. Open items (deferred to v2 or impl-time)

1. **Anthropic refresh endpoint URL** — read claude-swap source during impl to confirm exact path + payload shape; failure mode if Anthropic changes it.
2. **`vault watch` daemon mode** — revisit if pull-on-use latency annoys.
3. **Encrypted backup / disaster recovery** (`cvault export --encrypted backup.json` w/ user passphrase).
4. **Notification on refresh failure** (Slack / email webhook).
5. **Encryption key rotation** (dual-key envelope + cron rewrap).
6. **Per-user mutation rate limiting** via convex-helpers.
7. **Multi-org / team sharing** — Q1=A excludes; existing `organizations` Blueprint tables stay unused, available for v2.

---

## 15. Decision log

| Decision                      | Choice                                                                        | Reason                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sharing model                 | Single user, multi-sub, multi-machine                                         | Avoids ToS violation of pool-sharing                                                                                                                                                                                                                                                     |
| Relationship to `claude-swap` | Wrap (not replace, not fork)                                                  | Vendor handles Keychain; `vault` adds sync layer                                                                                                                                                                                                                                         |
| Backend stack                 | Blueprint 2.0 (Convex + Clerk + CFP + TanStack Start)                         | User preference; Convex realtime + atomic mutations fit refresh race protection                                                                                                                                                                                                          |
| Refresh strategy              | Convex scheduled action                                                       | Race-free, no leader, machines stay simple                                                                                                                                                                                                                                               |
| Auth model                    | Clerk only, no per-device tokens                                              | Clerk already manages sessions per machine                                                                                                                                                                                                                                               |
| Add flow                      | Local-first via wrapped `claude-swap`                                         | Anthropic OAuth client closed; no MITM viable                                                                                                                                                                                                                                            |
| Local sync                    | Pull-on-use, no daemon                                                        | YAGNI; daemons rot                                                                                                                                                                                                                                                                       |
| CLI runtime                   | TypeScript on Bun (pivot 2026-05-02)                                          | Stack consistency (one language across CLI + backend + frontend); Convex TS SDK is canonical (Python `convex` 0.7.0 is sync-only, no HTTP-action helpers, no subscriptions); generated types via `convex/_generated/api` removes drift; `bun build --compile` ships single static binary |
| CLI distribution              | `bun build --compile` → Homebrew tap + GitHub Releases                        | Single binary, no runtime dep on user machine; `bunx cvault` for Bun-equipped users                                                                                                                                                                                                      |
| CLI auth flow                 | Browser-assisted Clerk sign-in token + ticket exchange via localhost callback | Per `clerk-convex-tanstack-integration` brief: Clerk has no native device flow for own-app sessions; sign-in token + ticket is the de-facto equivalent; token never hits URL bar / referer (POST'd from dashboard to `127.0.0.1:<port>`)                                                 |
