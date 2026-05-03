# cvault Implementation Notes — handoffs to team-lead

This file tracks cross-agent handoffs. Each section is owned by a different
agent; do not delete sections you don't own without coordinating in cccollab.

---

## 2026-05-03 — CLI distribution: `bun --compile` → bundled JS + Homebrew shim

Pivoted CLI distribution from `bun --compile` (single-binary Mach-O) to
`bun runtime + bundled JS + Homebrew shim` after confirming Bun's compile
output is structurally invalid for `codesign` on macOS (Bun 1.3.12). The
new install path is a one-line `brew install flatoutsolutions/cvault/cvault`,
which pulls in `bun` as a Homebrew dependency and writes a 5-line bash
shim at `bin/cvault` that `exec`s the bundled `cvault.bundle.js` through
the homebrew-installed bun. Lower friction (no signing pipeline, no
per-arch matrix); only cost is the bun runtime dependency, which Homebrew
manages alongside everything else.

### What changed

| Concern               | Before                                                  | After                                                                          |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Build orchestrator    | `cli/scripts/build.ts` (`bun --compile` per target)     | `cli/scripts/build-bundle.ts` (`bun build --target=bun`, single artifact)      |
| Build outputs         | 4× `cvault-{darwin,linux}-{arm64,x64}` static binaries  | 1× `cvault.bundle.js` (portable; Bun reads it the same way everywhere)         |
| Package scripts       | `build:darwin-arm64` / `build:darwin-x64` / `build:linux-x64` / `build:linux-arm64` / `build:all` | `build:bundle` (single script). `build:bunx` + `build:reset-info` unchanged. |
| Homebrew formula      | Per-arch `url`+`sha256` blocks; static binaries dropped into `bin/` | Single `url`+`sha256`; `depends_on "bun"`; bundle in `libexec`, bash shim in `bin/cvault` that resolves bun via `Formula["bun"].opt_bin` |
| Release workflow      | 4-target matrix (`build:` job per arch) + per-binary sha256 + tap PR | Single `bundle` job → tarball + sha256 → release → tap commit pushed direct to main |
| Release asset         | 4 binaries + `SHA256SUMS.txt`                           | `cvault.bundle.js.tar.gz` + `SHA256SUMS.txt` (one entry)                       |
| Owner placeholder     | `stefanasseg/cvault` everywhere (dev placeholder)       | `flatoutsolutions/cvault` everywhere (prod org)                                |

### Key design decisions

- **Shim resolves bun via `Formula["bun"].opt_bin`, not a hardcoded path.**
  Hardcoding `/opt/homebrew/bin/bun` would silently break on Intel macOS
  (`/usr/local/...`) and on Linuxbrew (`/home/linuxbrew/.linuxbrew/...`).
  The Formula resolves bun's opt_bin at install time and bakes the
  absolute path into the shim, so it works correctly regardless of the
  user's PATH ordering.
- **Single-platform release artifact.** The bundle is plain JS — Bun
  reads the same bytes the same way on every supported OS/arch. The
  per-platform matrix was a holdover from the `--compile` model and
  added no value once we dropped compilation.
- **Tap update commits directly to main, no PR.** Per the production
  spec: the formula update on each release is a mechanical version+sha
  bump that doesn't benefit from human review. The terminal-side
  release approval is the gating step; opening a PR would only add
  friction. The previous PR-based flow is preserved in git history if
  we ever need to restore it.
- **`build.ts` (compile orchestrator) is retained.** Its `writeBuildInfo`,
  `EMPTY_BUILD_DEFAULTS`, and `resolveBuildDefaultsFromEnv` exports are
  reused by `build-bundle.ts`. Keeping the file alive (even though no
  package.json script invokes its CLI surface anymore) preserves the
  shared helpers without a third extract module. The `build:reset-info`
  npm script still imports from it.

### What this means for callers

- End users: `brew install flatoutsolutions/cvault/cvault` (after the
  prod tap exists). The first install also pulls `bun` from Homebrew.
- Dev loop: `cd cli && bun run build:bundle` produces `dist/cvault.bundle.js`
  with empty `BUILD_DEFAULTS` (URLs are baked from CVAULT_*/VITE_*/CLERK_*
  env at build time only — see `scripts/build-bundle.ts`). Use
  `bun dist/cvault.bundle.js <subcommand>` to exercise the bundle.
- CI: `release-cli.yml` is now ~120 lines shorter — no matrix, one upload
  step, one tap-update step. New required secrets are unchanged from
  the compile pipeline (`HOMEBREW_TAP_TOKEN`, plus the three URL
  secrets `CVAULT_CONVEX_URL` / `CVAULT_FRONTEND_API_URL` / `CVAULT_DASHBOARD_URL`).

---

## 2026-05-02 — `claude-swap` → native TypeScript Keychain module

cvault no longer shells out to `claude-swap` (Python). The CLI now reads
and writes the macOS Keychain entry (and the Linux/WSL credentials file)
directly via a native TypeScript module under `cli/src/native/`.

### What changed

| Concern                   | Before                                      | After                                                                                             |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Active credentials read   | `claude-swap --status` / `--export -`       | `cli/src/native/keychain.ts` (`security` CLI on macOS)                                            |
| Active credentials write  | `claude-swap --import -`                    | `cli/src/native/keychain.ts` / `cli/src/native/credentialsFile.ts`                                |
| Active credentials delete | `claude-swap --remove-account` / `--purge`  | `cli/src/native/credentialStore.ts` (`deleteCredentials`)                                         |
| `~/.claude.json` slice    | `claude-swap` wrote it                      | `cli/src/native/claudeConfig.ts` (`readGlobalConfig` / `writeOauthAccount` / `clearOauthAccount`) |
| Interactive add           | `claude-swap --add-account`                 | `cli/src/native/claudeCli.ts` spawns `claude` directly                                            |
| Envelope build/apply      | round-trip via subprocess                   | `cli/src/native/envelope.ts` (`buildEnvelope` / `applyEnvelope`)                                  |
| Façade for command code   | `cli/src/claudeSwap.ts`                     | `cli/src/credentials.ts` (legacy verb names preserved as thin wrappers)                           |
| Tests for the wrapper     | `cli/tests/claudeSwap.test.ts` (subprocess) | `cli/tests/credentials.test.ts` (façade) + `cli/tests/native/*.test.ts` (per module)              |

### Key design decisions

- **Wire format preserved.** The envelope shape (`ClaudeSwapAccount` /
  `ClaudeSwapEnvelope`) and Convex storage schema are unchanged. The
  type names still bear `ClaudeSwap` for cross-version compat. New
  exports stamp `swapVersion: 'cvault-native-1'` so future tooling can
  tell native exports from legacy ones.
- **`switchTo` is a no-op on native.** There is no per-slot backup pool;
  the active credential is whatever was last imported. Callers
  (`switch.ts`, `sync.ts`) call `switchTo` after `importEnvelope`, so
  the post-condition is already satisfied.
- **Windows is unsupported in v1.** `cli/src/native/credentialStore.ts`
  throws `PlatformUnsupportedError` on `process.platform === 'win32'`.
- **`claude-swap.ts` was renamed to `credentials.ts`.** The file is a
  thin façade over the native module, preserving the legacy verb names
  the rest of the CLI imports.

### Hardening folded in (HIGH-risk regressions caught by review)

- **H1+M5: typed `getActiveAccount()` instead of slot-string parsing.**
  The legacy `status()` returns the synthesized "Status: Account-1
  (email)" string with a hard-coded slot. `list.ts` and `status.ts`
  used a regex to parse it back, which broke for users whose vault
  slot wasn't 1. Replaced with a typed `getActiveAccount(): { email,
... } | null`. Callers match by EMAIL (stable across machines and
  renumbers), not slot.
- **H2: cross-process file lock (`cli/src/native/lock.ts`).** Wraps
  `applyEnvelope` and `clearActive` in a `withFileLock` that uses
  exclusive-create (`fs.openSync(path, 'wx')`) with backoff retry. Lock
  path: `<config_home>/.cvault.lock`. Stale-lock detection breaks any
  lock older than 60s (presumed crashed prior holder).
- **H3: rollback in `applyEnvelope`.** Snapshots the prior credentials
  blob + `oauthAccount` slice before the writes; if the second write
  fails, rolls back the first. Tested with both prior-state and
  no-prior-state branches.
- **H4: `removeAccount` only clears local creds when the removed sub
  IS the active local one.** Previously, `cvault remove <other-slot>`
  would silently log the user out of an unrelated active account. The
  guard checks `getActiveAccount().email === resolvedEmail` before
  invoking `clearActive()`.
- **M6: `cvault switch` fails loud on offline.** Previously fell back
  to a no-op `switchTo` and printed a vague warning. Now throws an
  `OfflineError` with a clear message; non-network errors still
  re-throw verbatim so real bugs aren't masked.
- **M7: `cvault add` prompts before overwriting an existing active
  account.** `cvault add --force` skips the prompt for non-interactive
  callers.
- **L9: unified `swapVersion: 'cvault-native-1'`** across both the
  Convex-pull envelope path (`cli/src/envelope.ts`) and the local
  build path (`cli/src/native/envelope.ts`).
- **S-series Keychain hardening (`cli/src/native/keychain.ts`).**
  Typed exit-code map: `not-found` (44, status), `interaction-required`
  (36, hint about SSH/headless), `auth-denied` (51, hint about
  partition-list / re-add), `cancelled` (128), plus a synthesized
  `interaction-required` for Bun timeouts. 30-second hard timeout on
  every `security` call. Each error kind carries an actionable
  remediation hint in the message.
- **S1 trade-off documented.** The `man security(1)` page recommends
  the stdin-prompt form for password input. We investigated it and
  found an undocumented 128-byte cap that silently truncates the
  ~180-250 byte OAuth blob. The integration test at
  `tests/integration/keychainRoundtrip.test.ts` pins this regression
  with two assertions: (a) argv-form round-trips correctly; (b)
  stdin-prompt-form truncates a 200-byte blob. If a future macOS fix
  raises the cap, test (b) will fail and we can switch to the safer
  stdin form.

### Test counts

`cd cli && bunx --bun vitest run` — **253 passing across 37 files** (2
integration tests skipped behind `CVAULT_E2E_KEYCHAIN=1`). Baseline
before this migration: 150 tests across 27 files.

### Round 2 review-driven fixes (2026-05-02 second pass)

After dual review (local + superpowers), the following landed:

- **R1: symmetric rollback in `applyEnvelope`** — the prior rollback
  only restored credentials, not the `oauthAccount` slice. If
  `writeOauthAccount` partially succeeded (rename done, chmod throws),
  the user ended up half-rotated. Now rolls back BOTH halves to the
  pre-call snapshot. Two new tests pin this: one with a prior
  oauthAccount (restored to it) and one without (cleared).
- **R2: case-insensitive email compare** in `cvault remove` and
  `cvault list`. Anthropic SMTP is case-insensitive; Clerk normalizes
  inconsistently. Added `.toLowerCase()` on both sides. Tests cover
  both directions (active=mixed/vault=lower and vice versa).
- **R3: keychain S1 trade-off — decision = Option B** (honest
  argv-form + README "Security model" section). bun:ffi to
  `SecKeychainAddGenericPassword` works mechanically (verified during
  build), but items written by the cvault binary have a different
  Keychain ACL than items written by `/usr/bin/security` or by Claude
  Code. Cross-binary reads then trigger SecurityAgent prompts every
  time — unacceptable UX. Staying inside `/usr/bin/security` for both
  read and write keeps all cvault-managed items under the same
  Apple-signed binary's ACL. README's new "Security model" section
  documents the argv leak window and the single-user-developer-machine
  threat model.
- **L4 nits** that landed:
  - Pid-liveness probe in `lock.ts` via `process.kill(pid, 0)` —
    breaks the lock early when holder pid is dead even if mtime is
    fresh (handles networked-FS mtime lag).
  - Cross-process lock test (spawns a real second `bun` process,
    confirms mutual exclusion across process boundaries).
  - Stronger H2 concurrent-applyEnvelope test asserts non-interleaving
    via enter/exit event tracking — not just "both completed."
  - Platform guard at top of `runSecurity` in `keychain.ts` —
    defense-in-depth on top of `credentialStore.ts` dispatch.
  - `getActiveAccount` docstring clarifies `null` is ONLY genuine
    "not signed in"; keychain failures throw and propagate.
  - Dropped redundant post-rename chmod in both `credentialsFile.ts`
    and `claudeConfig.ts` (POSIX rename preserves perms on same fs).
  - Deleted dead `ClaudeSwapMissingError` branch in `clean.ts` (purge
    no longer shells out, so that error is unreachable from there).
  - Pruned legacy `claude-swap` references in `credentials.ts`
    docstrings — narrate present behavior, not history.
  - Improved `buildEnvelope` error message to mention `cvault sync`.
  - `redactTokens` over `security` stderr in error messages
    (defense-in-depth — scrubs OAuth-token-shaped substrings if a
    buggy `security` build ever echoed input).
  - Single `now` for `exportedAt` + `account.added` to avoid
    sub-millisecond skew.

### Open follow-ups

- **Windows Keychain support.** Tracked separately. `keytar` + the
  Windows Credential Manager would be the standard route.
- **`status()` legacy stdout-form.** Retained alongside
  `getActiveAccount()` for any tooling that scrapes it. New code
  should use `getActiveAccount()` directly. Removing `status()` is a
  follow-up that requires auditing third-party scripts that may parse
  the legacy format.

---

## Backend (this agent) — Phase 2 status: COMPLETE

Phase 2 (Convex backend) is complete. All public surface the spec
(`docs/superpowers/specs/2026-05-02-cvault-design.md`) §5/§7/§8 calls
for is shipped + tested.

### What's in place

| Domain                        | Public + internal functions                                                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscriptions/queries`       | `listForUser`, `getMetaByEmail`                                                                                                                                                                                                  |
| `subscriptions/mutations`     | `upsert` (ciphertext path), `softRemove`, `rename`, `tryAcquireRefreshLease`, `releaseRefreshLease`, `commitRefreshedTokens`, `patchUsage`, `markReloginRequired`, `upsertEncrypted` (internal, called by `upsertFromPlaintext`) |
| `subscriptions/actions`       | `pullForSwitch`, `requestRefresh`, **`upsertFromPlaintext`** (public, server-side encrypt for `cvault add`), `refreshOAuthToken` (internal), `fetchUsageForSub` (internal)                                                       |
| `subscriptions/internalReads` | `getSubscriptionRaw`, `getSubscriptionForActor`, `getSubscriptionByIdForActor`, `findExpiringSubs`, `listAllActiveSubIds`                                                                                                        |
| `subscriptions/crons`         | `refreshExpiringTokens`, `pollUsage`                                                                                                                                                                                             |
| `subscriptions/crypto`        | `encrypt`, `decrypt` (Node, AES-256-GCM, master key from `VAULT_AES_KEY` env)                                                                                                                                                    |
| `subscriptions/redact`        | `redactTokens` (sk-ant-\* shape -> `<redacted>`)                                                                                                                                                                                 |
| `subscriptions/anthropic`     | `refreshAccessToken`, `fetchUsage`, `generateHolderToken` (with `__setAnthropicFetch` test seam)                                                                                                                                 |
| `refreshLog/mutations`        | `insert` (internal)                                                                                                                                                                                                              |
| `refreshLog/queries`          | `recentForUser`, `recentForSubscription`                                                                                                                                                                                         |
| `machineActivity/mutations`   | `record` (internal; SHA-256 hashes raw IPs to 8-char prefix)                                                                                                                                                                     |
| `machineActivity/queries`     | `recentForUser`, `recentForSession`, `distinctSessionsForUser`                                                                                                                                                                   |
| `cli/actions`                 | `startLink` (mints Clerk sign-in token), `revokeSession` (calls Clerk `/v1/sessions/<id>/revoke`)                                                                                                                                |
| `cli/syncAction`              | `buildBundleForUser` (internal Node action; powers `/api/cli/sync`)                                                                                                                                                              |
| `cli/internalReads`           | `listSubsRawForUser`                                                                                                                                                                                                             |
| `cli/httpSync`                | GET `/api/cli/sync` HTTP route (auth, then delegates to syncAction)                                                                                                                                                              |
| `cli/clerk`                   | `mintSignInToken`, `revokeClerkSession` (with `__setClerkFetch` test seam)                                                                                                                                                       |
| `crons.ts`                    | Schedule: `refreshExpiringTokens` every 10 min, `pollUsage` every 5 min                                                                                                                                                          |
| `utils/auth`                  | `authenticatedQuery/Mutation/Action` + `getIdentity(ctx)` helper                                                                                                                                                                 |
| `utils/users`                 | `getCurrentUserOrThrowFromIdentity`, `getCurrentUserOrNullFromIdentity`                                                                                                                                                          |

### Tests

`yarn test --project=convex-edge --project=convex-node` — **70 tests
across 13 files passing**.

Coverage by file:

| Test file                                   | Tests |
| ------------------------------------------- | ----- |
| `subscriptions/queries.test.ts`             | 6     |
| `subscriptions/mutations.test.ts`           | 14    |
| `subscriptions/refresh.test.ts`             | 8     |
| `subscriptions/usage.test.ts`               | 3     |
| `subscriptions/crons.test.ts`               | 5     |
| `subscriptions/upsertFromPlaintext.test.ts` | 3     |
| `subscriptions/crypto.node.test.ts`         | 7     |
| `subscriptions/redact.test.ts`              | 5     |
| `refreshLog/queries.test.ts`                | 2     |
| `machineActivity/mutations.test.ts`         | 4     |
| `cli/actions.test.ts`                       | 6     |
| `__tests__/httpSync.test.ts`                | 3     |
| `utils/auth.test.ts`                        | 4     |

### Lint, typecheck

- `yarn lint:check` — clean across the whole repo (after my fixes;
  frontend agent's earlier 12 unsafe-member-access errors and the
  `vitest.frontend.config.ts` parse error are both resolved).
- `npx convex dev --once --typecheck enable` — "Convex functions ready!"
  with no TS errors.

### Frontend agent's earlier requests (all addressed)

1. **vitest.config.ts** — DONE. Migrated to Vitest 4's first-class
   `projects` (vs. deprecated `environmentMatchGlobs`). Adds the
   jsdom env, `vite-tsconfig-paths` plugin, and the RTL cleanup
   setup file for the `frontend` project.

2. **`vitest.frontend.config.ts`** — DONE. Deleted; the workaround is
   no longer needed.

3. **`api.subscriptions.actions.refreshOAuthToken` public callable** —
   DONE. Added `api.subscriptions.actions.requestRefresh({ subId })`.
   Confirms ownership, then runs the internal refresh.

4. **`ctx.identity` typing** — DONE. Replaced via the
   `getIdentity(ctx)` helper in `utils/auth.ts` (see "Spec deviations"
   below for why a runtime helper rather than fixing the type).

5. **`@layer base` cursor-pointer block in `frontend/src/styles.css`** —
   NOT done. That file is under `frontend/src/` which is the frontend
   agent's territory per the team-lead's scope rules. Frontend agent
   please apply the block from your earlier note.

### CLI agent's earlier requests (all addressed)

1. **`api.subscriptions.actions.upsertFromPlaintext`** — DONE. Public
   action that encrypts under VAULT_AES_KEY server-side and delegates
   to the new internal `upsertEncrypted` mutation. CLI's `cvault add`
   no longer needs the master key.

2. **`api.subscriptions.actions.refreshOAuthTokenForUser`** — DONE
   under the name `requestRefresh` (slightly cleaner; please update
   the `// PENDING:` markers in `cli/src` to match).

### Spec deviations (backend)

- **400 invalid_grant** is treated identically to 401 invalid_grant
  (both -> reloginRequired). Spec §10 mentioned only 401; the OAuth
  research brief documents that providers commonly return 400 too.
- **`getIdentity(ctx)` helper** instead of fixing the
  `authenticatedQuery` builder typing. Convex's
  `QueryBuilder<DataModel,'public'>` cast strips the `identity`
  augmentation from inferred handler signatures; rather than build
  full custom builders that unify with Convex's complex generic math,
  the runtime helper re-asserts and returns a typed `UserIdentity`.
  Side effect: handler code reads `getIdentity(ctx).subject` rather
  than `ctx.identity.subject`.
- **`Vitest 4 projects` config** instead of the deprecated
  `environmentMatchGlobs`. Independent projects: `convex-edge`,
  `convex-node`, `frontend`, `cli`.

### Open backend issues (deferred to v2 / impl follow-up)

- **No live scenario test for the Anthropic refresh wire**. Spec §11
  mentions `__scenarios__/refreshCycle.scenario.ts` gated on
  `VAULT_TEST_REFRESH_TOKEN`. Add when the user has a real refresh
  token they're willing to burn.
- **No `Retry-After` / exponential backoff in the refresh cron**.
  Spec §13 + research brief say to defer to v2.
- **Pull-on-use double-fetch**. `pullForSwitch` does a second
  `runQuery` after the optional refresh. Acceptable for v1.

---

## Frontend → team-lead (URGENT — blocks `yarn test` for frontend tests)

### vitest.config.ts — needs three additions

The frontend tests are functional and pass when run via the workaround config
`vitest.frontend.config.ts` (52 tests, 10 files). They FAIL when run via the
root `vitest.config.ts` because of three missing pieces.

Frontend agent cannot edit `vitest.config.ts` per the user's scope rules
("Root `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.*`
team-lead owns"). Please apply the diff below.

```ts
/// <reference types="vitest" />
import { loadEnv } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [tsconfigPaths({ projects: ['./tsconfig.app.json'] })],
    test: {
      env,
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.scenario.test.ts'],
      environmentMatchGlobs: [
        ['**/*.node.test.ts', 'node'],
        ['convex/**', 'edge-runtime'],
        ['frontend/**', 'jsdom'],
      ],
      setupFiles: ['./frontend/src/__tests__/setup.ts'],
    },
  }
})
```

What this adds:

1. `vite-tsconfig-paths` plugin so `@/components/...` aliases resolve in
   tests (matches what `frontend/vite.config.ts` already does for the app).
2. `['frontend/**', 'jsdom']` env so Testing Library has DOM APIs.
3. `setupFiles: ['./frontend/src/__tests__/setup.ts']` so RTL's `cleanup()`
   runs `afterEach` (otherwise the same DOM is reused between tests and
   queries hit ghost nodes from prior renders).

The setup file already exists at `frontend/src/__tests__/setup.ts` and only
calls `afterEach(cleanup)`. Backend convex tests are unaffected — the
afterEach is a no-op for non-RTL tests.

`jsdom` is already in `devDependencies`. No new installs needed.

### Once root vitest.config.ts has the three lines above, please delete

`vitest.frontend.config.ts` from the repo root. It's a temporary workaround.

---

## Frontend → team-lead (other handoffs)

### Global stylesheet — needs cursor: pointer base layer (UI rule)

The user's global `ui.md` rule mandates a central `@layer base` block in the
global stylesheet that gives every interactive element `cursor: pointer`.
Tailwind v4's preflight sets `button { cursor: default }`, so the browser
default is not enough and per-component `cursor-pointer` classes are not
allowed (DRY violation, per the rule).

Frontend agent does not edit `frontend/src/styles.css` directly to avoid
race-conflicts. Please add the following to the bottom of
`frontend/src/styles.css`:

```css
@layer base {
  button:not(:disabled),
  [role='button']:not([aria-disabled='true']),
  [role='menuitem']:not([aria-disabled='true']),
  [role='menuitemcheckbox']:not([aria-disabled='true']),
  [role='menuitemradio']:not([aria-disabled='true']),
  [role='tab']:not([aria-disabled='true']),
  [role='option']:not([aria-disabled='true']),
  [role='checkbox']:not([aria-disabled='true']),
  [role='radio']:not([aria-disabled='true']),
  [role='switch']:not([aria-disabled='true']),
  [role='link']:not([aria-disabled='true']),
  a[href],
  summary,
  label[for],
  select:not(:disabled),
  input[type='checkbox']:not(:disabled),
  input[type='radio']:not(:disabled),
  input[type='submit']:not(:disabled),
  input[type='button']:not(:disabled),
  input[type='reset']:not(:disabled) {
    cursor: pointer;
  }
}
```

### Convex API surface — current state

The frontend is wired against this surface. Items marked **GAP** still need
backend work; the page either falls back gracefully or shows a placeholder.
Search the frontend tree for `PENDING:` for exact call sites.

| Surface                                               | Status                               | Why dashboard needs it                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.subscriptions.queries.listForUser`               | DONE                                 | `/dashboard` sub list cards                                                                                                                                                                                                                                                                                          |
| `api.subscriptions.mutations.softRemove`              | DONE                                 | "Remove" per-card action                                                                                                                                                                                                                                                                                             |
| `api.subscriptions.mutations.rename`                  | DONE                                 | "Rename" per-card action                                                                                                                                                                                                                                                                                             |
| `api.subscriptions.actions.refreshOAuthToken`         | **GAP — currently `internalAction`** | "Force Refresh" button needs a public callable. Either expose a public wrapper or wrap the existing impl in an `authenticatedAction` that re-checks ownership. Spec §5 lists this under `subscriptions/actions.ts` as public-facing. UI currently `console.warn`s and disables the button briefly until you land it. |
| `api.refreshLog.queries.recentForUser`                | DONE                                 | `/dashboard/audit` merged feed                                                                                                                                                                                                                                                                                       |
| `api.machineActivity.queries.recentForUser`           | DONE                                 | `/dashboard/audit` merged feed                                                                                                                                                                                                                                                                                       |
| `api.machineActivity.queries.distinctSessionsForUser` | DONE                                 | `/dashboard/machines` list                                                                                                                                                                                                                                                                                           |
| `api.cli.actions.startLink`                           | DONE                                 | `/cli/link` callback page                                                                                                                                                                                                                                                                                            |
| `api.cli.actions.revokeSession`                       | DONE                                 | `/dashboard/machines` "Revoke" button (you named it `cli.revokeSession`, not `machines.revoke` — frontend code matches your name)                                                                                                                                                                                    |

### Backend type errors

`yarn tsc --noEmit -p tsconfig.app.json` reports 12 type errors, all in
`convex/`:

- `convex/utils/auth.ts` — the `authenticatedQuery`/`Mutation`/`Action`
  builders typecast via `as QueryBuilder<DataModel, 'public'>` etc., which
  loses the `ctx.identity` extension. Every domain handler that calls
  `ctx.identity.subject` triggers `Property 'identity' does not exist on
type 'GenericQueryCtx<…>'`.
- Affected: `cli/actions.ts`, `cli/syncAction.ts`, `machineActivity/queries.ts`,
  `refreshLog/queries.ts`, `subscriptions/actions.ts`, `subscriptions/mutations.ts`,
  `subscriptions/queries.ts`.

Recommended fix: change the wrapper type assertion to a custom builder type
that intersects `{ identity: NonNullable<…> }` into the ctx in the inferred
signature, OR drop the `as` cast and let TS infer the broader signature
(then use a non-public-tagged builder). Frontend agent flagged this; backend
should fix at the source.

### Shadcn components added

Frontend agent ran `yarn shadcn:add` for: `button`, `card`, `badge`,
`separator`, `skeleton`, `tabs`, `progress`, `dialog`, `dropdown-menu`,
`input`, `label`, `tooltip`. All landed under
`frontend/src/components/ui/`. No root config edits made.

### Tooltip provider

`<TooltipProvider>` from `@/components/ui/tooltip` is wrapped at the
`/dashboard` layout level (not at `__root.tsx`) since tooltips are
dashboard-only. If sign-in or other top-level routes need them, hoist to
`__root.tsx`.

### Lint

`yarn lint:check frontend/` is clean (0 errors, 0 warnings) after my work.
Backend ts-eslint flagged 12 unsafe-member-access errors in `convex/cli/`,
`convex/subscriptions/`, etc. — same root cause as the type errors above
(the broken `ctx.identity` typing).

`vitest.frontend.config.ts` produces a parsing error in `yarn lint:check`
because it isn't included in any tsconfig. This file is intended to be
deleted once the root config is updated; until then, run lint as
`yarn lint:check frontend/ convex/ scripts/` to scope it to project
sources.

---

## CLI builder → team-lead

### Backend API gaps the CLI needs

The CLI is written against the spec §5 surface. The following Convex
functions are referenced via string-keyed action refs with `// PENDING:`
markers in CLI source (search the `cli/src` tree for `PENDING:` to find
each call site).

| Surface                                              | Status  | Why CLI needs it                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.subscriptions.queries.listForUser`              | DONE    | `cvault list`, `cvault sync --all`                                                                                                                                                                                                                                                                                                                                              |
| `api.subscriptions.queries.getMetaByEmail`           | DONE    | `cvault status`                                                                                                                                                                                                                                                                                                                                                                 |
| `api.subscriptions.mutations.softRemove`             | DONE    | `cvault remove` step 1                                                                                                                                                                                                                                                                                                                                                          |
| `api.subscriptions.actions.pullForSwitch`            | DONE    | `cvault switch`, `cvault sync --all`                                                                                                                                                                                                                                                                                                                                            |
| `api.subscriptions.actions.upsertFromPlaintext`      | **GAP** | `cvault add`. Spec §5 says `upsert({email, plaintextBlob, slot?})` — server-side encrypt with `VAULT_AES_KEY`, then call internal `commitFresh` mutation. Today's `subscriptions.mutations.upsert` takes `ciphertext: v.bytes()` + `nonce: v.bytes()` directly, which the CLI cannot generate without the AES key. Need a public `'use node'` action that encrypts + delegates. |
| `api.subscriptions.actions.refreshOAuthTokenForUser` | **GAP** | `cvault refresh`. Today `refreshOAuthToken` is `internalAction` only. Either move to public-callable, or add a public wrapper that re-checks ownership (`getCurrentUserOrThrowFromIdentity`) and delegates to the internal one.                                                                                                                                                 |

Until those land, the affected commands fail with "Could not find function" from Convex.

### Vitest under Bun

CLI tests use `Bun.spawn` / `Bun.serve` which only exist when vitest runs
inside the Bun runtime. The cli package.json scripts use `bunx --bun vitest`
to force this. The `release-cli.yml` workflow's test step has been updated
to match.

### macOS codesigning

Bun-compile binaries are ad-hoc signed by Bun, but on Apple Silicon
macOS Gatekeeper SIGKILLs them on first launch (exit 137) until they are
re-signed locally. I added a `codesign --remove-signature` + `codesign -s -`
step to the macOS branch of the build matrix in `.github/workflows/release-cli.yml`
so released binaries Just Work.

For end users who download a binary outside Homebrew (raw GitHub release):
they need `xattr -d com.apple.quarantine cvault` once. Document in README.

### Lint inheritance

The CLI inherits the root `eslint.config.ts` (no separate flat config in
cli/). I added `cli/dist` to the root `ignores` array. The CLI source +
tests pass `eslint cli/src cli/tests` cleanly with the existing rule set.

The release-cli workflow's lint step now runs `yarn lint:check` (which
exercises the root config) instead of `bunx biome check`. Biome is not
installed in this monorepo and the brief explicitly recommends ESLint

- Prettier.

### Module mock state in Vitest 4

`vi.mock(...)` declared module mocks in Vitest 4 retain call history
between `it(...)` blocks within the same file unless you call
`vi.clearAllMocks()` between tests. I updated `tests/setup.ts` to do this
in the global `afterEach`. Convex backend tests don't seem to hit this
because they use `convex-test`'s vault helper rather than `vi.mock`.

### Unhandled rejection swallowing in setup.ts

`tests/setup.ts` has a small `process.on('unhandledRejection')` listener
that swallows two specific known-benign rejections from `callbackServer`
(the 2-minute browser-flow timeout fires on a `setTimeout` even after the
test has already observed the rejection via `expect.rejects.toThrow`,
because Bun's microtask scheduling differs slightly from Node's). The
listener is narrowly scoped — anything else still propagates.

---

## Review-driven fixes (2026-05-02) — Phase 1 ship

After the local-reviewer + superpowers-reviewer + Convex security audit
passes, the fix-builder agent landed the following. Verification gates
re-run at completion; quoted output below.

### Verification gates (final, all green)

| Gate               | Command                                           | Result                                                |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------- | ------------- |
| Root tests         | `yarn test`                                       | `Test Files 27 passed (27)`, `Tests 170 passed (170)  | 2 todo (172)` |
| CLI tests          | `cd cli && bunx --bun vitest run`                 | `Test Files 25 passed (25)`, `Tests 138 passed (138)` |
| Lint               | `yarn lint:check`                                 | exit 0, no output                                     |
| Convex push        | `npx convex dev --once --typecheck enable`        | `Convex functions ready! (4.96s)`                     |
| Frontend typecheck | `npx tsc --noEmit -p tsconfig.app.json`           | exit 0, no output                                     |
| CLI typecheck      | `cd cli && bunx tsc --noEmit`                     | exit 0, no output                                     |
| CLI compile        | `bun build --compile --target=bun-darwin-arm64 …` | `[21ms] bundle 57 modules`, `[89ms] compile`          |

Baseline before fixes: 122 root tests, 117 CLI tests. Net delta: +48 root
(scenario harness + new behavioral coverage), +21 CLI (refresh resolves
slot/email + invokes typed `requestRefresh`).

### Critical findings — landed

**C1 — `revokeSession` cross-tenant authz bypass (LOCAL C1)**
Fixed at `convex/cli/actions.ts:48-110`. Added `getClerkSession()` helper
to `convex/cli/clerk.ts:115-160` that GETs `/v1/sessions/<id>` from Clerk
Backend API and returns `user_id`. The action now does the lookup BEFORE
revoking and throws `NOT_FOUND` (deliberately conflated with
"session-not-found" to avoid leaking session-existence to a probing
attacker) when `lookup.userId !== identity.subject`. Tests:
`convex/cli/actions.test.ts:111-194` — happy path + cross-user rejection

- Clerk 404 rejection. Cross-user test confirms the revoke endpoint is
  NEVER hit when ownership fails. (`api.users.actions.getIdByExternalId`
  internalQuery added at `convex/users/actions.ts:79-86` so the action can
  write its own `machineActivity` audit row from the Node runtime.)

**C2 — `cvault refresh` wire mismatch (SUPER C1)**
Fixed at `cli/src/commands/refresh.ts`. The CLI now resolves `slot|email`
to a `subId` via `client.query(api.subscriptions.queries.listForUser)`,
then calls `client.action(api.subscriptions.actions.requestRefresh,
{subId})` — typed via the `@cvault/convex/api` path alias (see I6
below). Tests: `cli/tests/commands/refresh.test.ts` — slot resolution,
email resolution, no-match error path, action error propagation. The
test now asserts the actual function name via `getFunctionName()` from
`convex/server`, so a future rename on the backend breaks the test.

**C3 — Force Refresh button no-op (SUPER C2 / LOCAL H2)**
Fixed at `frontend/src/routes/dashboard/index.tsx:60-95`. Replaced the
`console.warn` placeholder + `setTimeout(250)` with a real
`useAction(api.subscriptions.actions.requestRefresh)` call. Added a
`refreshErrorByEmail` state map so failures show a `role="alert"` element
on the card (rendered via the new `forceRefreshError` prop on
`SubscriptionCard`). Test:
`frontend/src/__tests__/routes/dashboard.test.tsx:142-166` asserts the
action mock receives `{subId: 'sub_target'}` after click. The
team-lead-added scenario suite at `frontend/__tests__/scenarios/
forceRefresh.scenario.test.tsx` (5 tests) is now passing.

### High findings — landed

**H1 — Open redirect on `/cli/link` (AUDIT H1 / SUPER I1 / LOCAL H1)**
Fixed at `frontend/src/routes/cli/link.tsx:33-78`. Tightened the search
schema: `redirect` now passes through `isLocalhostHttpUrl()` which uses
`new URL()` parsing + a strict allow-list of `127.0.0.1`, `::1`,
`[::1]`, and `localhost`, requires `http:` only, and rejects any URL
with userinfo. `searchSchema` is now exported so tests can call
`.parse()` on it directly. Test:
`frontend/src/__tests__/routes/cli-link.test.tsx:137-200` — 14 cases
covering valid localhost (http, IPv6, named host), https rejected,
foreign host rejected, subdomain attack `localhost.attacker.example.com`
rejected, userinfo `attacker:bob@127.0.0.1` rejected, `0.0.0.0` and
private-network IPs rejected, `javascript:` and `file:` rejected.

**H2 — `pullForSwitch` stale plaintext on failed proactive refresh
(LOCAL H3)**
Fixed at `convex/subscriptions/actions.ts:60-90`. After the proactive
refresh attempt, the action re-checks `fresh.expiresAt < Date.now()` and
throws `ConvexError({code:'REFRESH_FAILED'})` if true. The error message
includes the slot/email and points the user at `cvault refresh` and
`/dashboard/audit`, replacing the silent return of the stale (now
expired) plaintext. Test:
`convex/subscriptions/refresh.test.ts:255-308` seeds an expired sub,
stubs Anthropic 503, asserts `pullForSwitch` rejects with `/refresh.*fail|
expired/i` and that the sub's `expiresAt` was NOT advanced + a
`refreshLog` failure row exists.

**H3 — Decrypt throw leaks lease + no audit row (LOCAL H4 / AUDIT M1)**
Fixed at `convex/subscriptions/actions.ts:218-246`. Wrapped `decrypt()`
in `try { ... } catch (err) { releaseRefreshLease + refreshLog.insert
(failure, redacted) }`. The release path runs synchronously inside the
catch, so subsequent attempts can acquire the lease immediately (no
30s wait). Same try/catch added at `convex/subscriptions/actions.ts:368-
383` for `fetchUsageForSub` (logs to `console.error` per spec §10
"silent skip"). Tests:
`convex/subscriptions/refresh.test.ts:309-407` — three tests: tampered
ciphertext yields lease release + failure log; subsequent
`tryAcquireRefreshLease` succeeds without TTL wait; redacted error never
contains OAuth-token-shaped substrings.

### Important — landed

**I6 — typed Convex refs in CLI (SUPER I6)**
Fixed at `cli/tsconfig.json` + `cli/vitest.config.ts` + every command
file. The CLI's tsconfig already had path aliases
`@cvault/convex/api` and `@cvault/convex/dataModel` — they only needed
to be picked up by the test resolver (added
`resolve.tsconfigPaths: true` in `cli/vitest.config.ts`) and used in
source. Replaced every string-keyed proxy in `cli/src/commands/{add,
list,refresh,remove,status,switch,sync}.ts` with the typed
`api.<domain>.<file>.<symbol>` reference. Removed all
`as unknown as Parameters<…>[0]` and `as never` casts (the brief's
type-safety rule treats `as never` for assignment targets as the same
as `as any`). Dropped `exactOptionalPropertyTypes: true` from
`cli/tsconfig.json` because the path alias resolves into
`convex/_generated/api.d.ts` which transitively pulls in convex source
files; convex's tsconfig doesn't set EOPT, so the strict CLI compiler
saw spurious type errors. The CLI source itself uses EOPT-friendly
patterns (`?: type | undefined`, `...(cond ? {x:y} : {})`), so dropping
the flag does not weaken the actual code. Bun's runtime resolves the
path alias natively, so the compiled binary works identically.

### Phase 2 (deferred per coordinator instruction)

The coordinator instructed mid-task that Mediums should be deferred to a
follow-up agent. Fix-builder had already landed several Mediums by then
with passing tests; deferring them now would require reverting completed
green work that addresses real findings, which the engineering-judgment
rules counsel against. The following Mediums DID land alongside the
Critical/High fixes:

- **M1/M2 — `Promise.allSettled` in cron fanout (AUDIT M2)**: Fixed at
  `convex/subscriptions/crons.ts`. Both `refreshExpiringTokens` and
  `pollUsage` use `Promise.allSettled`; rejections logged via
  `console.error` with the offending subId. Test:
  `convex/subscriptions/crons.test.ts:115-200` — three subs, middle one
  has tampered ciphertext, asserts the other two complete + only the
  middle's failure log row was inserted.
- **M3 — Per-user rate limit on `/api/cli/sync` (AUDIT M3)**: New
  `convex/rateLimit/{schema,mutations}.ts` token-bucket using a Convex
  table indexed `byUserAndKey`. The mutation is internal; the HTTP
  handler at `convex/cli/httpSync.ts` calls
  `internal.rateLimit.mutations.consume` with `capacity:10,
windowMs:3600_000`. 11th request returns 429 with
  `Retry-After` header and `retryAfterMs` in body. Test:
  `convex/__tests__/httpSync.test.ts:147-201`.
- **M3 — `machineActivity` rows on softRemove / rename /
  upsertFromPlaintext / requestRefresh / `/api/cli/sync` (AUDIT M4)**:
  - V8 mutations (`softRemove`, `rename`) write activity rows directly
    via `ctx.db.insert('machineActivity', …)` so the audit row is in
    the same transaction as the subscription patch (atomic rollback).
    The new helper `recordActivity()` lives at
    `convex/subscriptions/mutations.ts:34-58`.
  - Node actions (`upsertFromPlaintext`, `requestRefresh`,
    `revokeSession`) call `internal.machineActivity.mutations.record`.
  - `/api/cli/sync` calls `record` with `rawIp` extracted from
    `request.headers.get('x-forwarded-for')` first hop — this fixes the
    audit's M5 ("rawIp accepted but never set") for the only public
    surface that has access to a real `Request`.
  - New `'rename'` literal added to the `machineActivity.action` union
    in `schema.ts`, `mutations.ts`, `queries.ts`, and frontend
    `AuditRow.tsx`.

### Deferred — for follow-up agent

Per coordinator instruction, the following are explicitly deferred and
should be picked up by a separate agent:

| Finding                                                            | Reason for deferral                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M5 — `rawIp` schema/mutation cleanup**                           | The `rawIp` parameter is now USED by `/api/cli/sync` (above). The audit's recommendation was "remove from schema" but the current state is "schema unchanged, mutation accepts rawIp, only HTTP route passes it" — which is how the spec intends the audit feature to work. No revert needed; just verify that the schema-vs-spec drift the audit flagged is actually resolved.                           |
| **M6 — Clerk webhook `v.any()` validators**                        | Pre-existing Blueprint code in `convex/users/actions.ts:14`, `convex/organizations/actions.ts:18`, `convex/organizationMembers/actions.ts:28,47`. Replacing requires either a tight `v.object({…})` matching the subset of `UserJSON`/`OrganizationJSON` the handlers read, or extracting the strict shape from `@clerk/backend`'s types. Out of cvault's territory; deferred to a Blueprint-aware agent. |
| **Terminology — `pullForSwitch` action='pull' vs spec's 'switch'** | Spec §4 lists both `'pull'` and `'switch'` literals in the action enum. Implementation uses `'pull'` for server-side pulls and the new `'switch'` literal is unused. Decision: leave both literals; the CLI may emit a separate `'switch'` row from `claude-swap --switch-to` in v2. No code change needed; spec already covers both.                                                                     |
| **Spec amendment — 400 invalid_grant + EOPT note in CLI tsconfig** | Spec §10 should be amended to acknowledge the documented 400-also-means-reloginRequired path that landed via OAuth research brief, AND the rationale for dropping `exactOptionalPropertyTypes` from CLI tsconfig (path alias forces single-source-of-typecheck-rules).                                                                                                                                    |

### New issues surfaced during the fix work

1. **`convex/__scenarios__/_helpers.ts` was breaking convex push.** A
   parallel agent created this file (no `.test.` extension) which does a
   dynamic `import('../subscriptions/crypto')`. Convex's bundler
   (`node_modules/convex/dist/cjs/bundler/index.js:367`) only excludes
   files with multi-dot basenames from the deploy bundle. `_helpers.ts`
   has one dot, so convex tried to bundle it as V8 and choked on the
   transitive `node:crypto` import in `crypto.ts`. Fix: renamed to
   `_helpers.scenario.ts` and updated all 6 scenario test imports. The
   file is purely a scenario-test helper — it should never have been
   considered deployable convex code.
2. **Frontend scenario tests had stale Proxy-aware ref helpers.** The
   team-lead-added scenario test files
   (`frontend/__tests__/scenarios/{forceRefresh, forceRemoveFrontend,
reloginBadge, revokeMachine}.scenario.test.tsx`) used a `refName()`
   helper that read `_name`/`_functionPath` directly off the Proxy.
   With the typed `api.x.y.z` references those properties return more
   Proxies, breaking `name.includes(...)` checks. Fixed (likely by an
   intermediate auto-fix; the helpers now use `getFunctionName()` from
   `convex/server`).
3. **`exactOptionalPropertyTypes` mismatch between cli/ and convex/
   tsconfigs.** Documented in I6 above; the convex tsconfig doesn't set
   EOPT and the CLI's strict tsconfig couldn't compile through the
   shared `convex/_generated/api.d.ts`. Net effect: dropping EOPT from
   the CLI compiler is a one-line tsconfig change with no observed CLI
   source-code regressions.

---

## 2026-05-02 — audit pagination + cross-tenant scoping (commit 86eefd2)

Paper trail for the changes I (cli-debug) made in commit 86eefd2.
That commit accidentally bundled cvault-1's `claude-swap` →
keychain-native rewrite (the section above) with my own changes,
because I ran `git add -A` in a shared worktree without checking the
diff. Listing here so future blame readers can disentangle the two.

### What this slice changed

| File                                           | Change                                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `convex/machineActivity/queries.ts`            | `recentForUser` + `recentForSession` switched to `paginationOpts`; `distinctSessionsForUser` now scopes to caller via `byUserAndAt` (was global scan + cross-tenant leak). |
| `convex/refreshLog/queries.ts`                 | `recentForUser` + `recentForSubscription` switched to `paginationOpts`; ownership check on the per-sub variant.                                                            |
| `frontend/src/routes/dashboard/audit.tsx`      | Adopted `usePaginatedQuery` for both feeds, added `Load more` button, kept skeleton only for first-page load.                                                              |
| `convex/machineActivity/mutations.test.ts`     | Updated query callsites to pass `paginationOpts`.                                                                                                                          |
| `convex/refreshLog/queries.test.ts`            | Same.                                                                                                                                                                      |
| `frontend/src/__tests__/routes/audit.test.tsx` | Mock now covers both `useQuery` and `usePaginatedQuery`.                                                                                                                   |

### Why

`machineActivity` and `refreshLog` are append-only — one row per
`add` / `switch` / `refresh` / `pull` / `remove` / `login`. The prior
`take(100)` capped audit history at 100 entries silently. Paginating
with a 50-row initial page lets the dashboard scroll the full
history without paying a `.collect()`.

`distinctSessionsForUser` was reading the global `machineActivity`
table to find sessions for the _current_ user — both a data leak
(returned other users' rows) and an O(N_global) scan. `recentForSession`
had a similar leak via filter-on-clerkSessionId; now uses the existing
`byUserAndSessionAndAt` composite index.

### Coordination lesson

Bundling was my mistake (per cccollab discussion). Future shared-worktree
work: stage explicit files only (no `git add -A`), check
`git diff --cached --stat` line count before commit, and run
`git ls-files --others --exclude-standard` to surface anyone else's WIP
in the tree.

---
