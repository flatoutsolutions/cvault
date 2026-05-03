# cvault Production Deployment

**Date:** 2026-05-03
**Status:** approved
**Branch:** `feat/production-deployment`

## Goal

Take cvault from "works locally" to "deployed to production with one-click Homebrew install."

## Architecture (no change from existing)

- **Backend:** Convex prod deployment `patient-koala-335`
- **Frontend:** Cloudflare Pages (project `cvault`, default domain `cvault.pages.dev`)
- **Auth:** Clerk prod tenant configured against the Cloudflare Pages domain
- **CLI distribution:** Homebrew formula installing `bun` + bundled JS + tiny shim

## Three execution tracks

### Track A — CLI distribution pivot (Bun bundle, no `--compile`)

Bun's `--compile` output is structurally invalid for codesign on macOS (Bun 1.3.12, verified empirically). Pivot to a `bun + bundled JS + shim` install model.

**Changes:**

- Drop `--compile` from build pipeline. New script: `cli/scripts/build-bundle.ts` runs `bun build --target=bun ./src/index.ts --outfile dist/cvault.bundle.js --minify --sourcemap`.
- Update `cli/package.json` build scripts to invoke the bundle orchestrator.
- Rewrite `Formula/cvault.rb`:
  - `depends_on "bun"`
  - `libexec/install "cvault.bundle.js"` and a `cvault` shim wrapper at `bin/` (Ruby interpolates the helpers at install time so this works under Apple Silicon, Intel, and Linuxbrew prefixes):
    ```ruby
    (bin/"cvault").write <<~SHIM
      #!/bin/bash
      exec "#{Formula["bun"].opt_bin}/bun" "#{libexec}/cvault.bundle.js" "$@"
    SHIM
    chmod 0755, bin/"cvault"
    ```
  - Update caveats accordingly.
- Owner placeholder swap: `stefanasseg` → `flatoutsolutions` everywhere in `Formula/cvault.rb` and `.github/workflows/release-cli.yml`.
- Update `release-cli.yml` to upload `cvault.bundle.js` + `SHA256SUMS.txt`. Drop per-platform binaries (Bun is portable).

**Acceptance:**

- `brew install flatoutsolutions/cvault/cvault` (after tap exists) installs and runs from `/usr/local/bin/cvault`.
- Bundle test: a built `cvault.bundle.js` runs via `bun cvault.bundle.js list` from any directory and uses `BUILD_DEFAULTS` for URLs.

### Track B — Should-fix bundle (no creds)

Items 8–13 from the gap list:

| #   | File                                                 | Fix                                                                                                                                             |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 8   | `cli/tests/clean.test.ts`                            | Replace `require()`-style imports with ESM imports                                                                                              |
| 9   | `frontend/src/routes/*`                              | Add lazy-loaded routes via TanStack Start `lazyRouteComponent`                                                                                  |
| 10  | `convex/subscriptions/queries.ts` `findExpiringSubs` | Add Convex index on `expiresAt`                                                                                                                 |
| 11  | `docs/research/perf-findings.md`                     | Refresh stale numbers, mark superseded entries                                                                                                  |
| 12  | `cli/tests/scenarios/*`                              | NEW scenario tests for: cross-machine race during rotation; concurrent same-machine `cvault switch` lock contention; mixed-case email roundtrip |
| 13  | `docs/architecture/observability.md` (NEW)           | Monitoring/alerting proposal — Convex logs + Cloudflare Web Analytics for v1; reserve Sentry for v2 if user signal indicates need               |

### Track C — Production credential setup (user does)

User-blocked items, documented as a checklist:

1. **Cloudflare Pages project:**

   ```
   yarn install && CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
     npx tsx scripts/setupCloudflareProject.ts --project-name cvault
   ```

   Returns the default domain `cvault.pages.dev`.

2. **Clerk prod tenant:**
   - Create tenant on `clerk.com`
   - Set domain to `https://cvault.pages.dev` (or your custom DNS)
   - Create JWT template named `convex` with `aud: convex`
   - Add webhook to `https://patient-koala-335.convex.site/webhooks/clerk` (events: `user.created/updated/deleted`)

3. **GitHub Actions secrets** (`flatoutsolutions/cvault` repo):
   - `CONVEX_DEPLOY_KEY` — from Convex prod dashboard
   - `CLERK_PUBLISHABLE_KEY` — Clerk prod
   - `CLERK_SECRET_KEY` — Clerk prod
   - `CLERK_WEBHOOK_SECRET` — Clerk prod webhook
   - `CLOUDFLARE_API_TOKEN` — CF dashboard, Pages:Edit + Account:Read
   - `HOMEBREW_TAP_TOKEN` — PAT with write to `flatoutsolutions/homebrew-cvault`

4. **GitHub Actions vars** (same repo):
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_PROJECT_NAME=cvault`
   - `ENVIRONMENT=production`
   - `VITE_APP_TITLE=cvault`

5. **Tap repo:** create empty `flatoutsolutions/homebrew-cvault` (release-cli.yml writes the formula on each tag push).

## Out of scope (v1)

- Custom domain (cvault.dev). Stick with `cvault.pages.dev`.
- Sentry / external observability. Convex logs only.
- Multi-region failover.
- Apple Developer ID code-signing for the CLI (not needed with Bun-runtime model).
- Linux/Windows-specific Bun-runtime install paths (Bun supports both; defer per-OS package managers to v2).

## Pre-existing divergence to revert

Three CI commits (`19e6fb8`, `2aade41`, `8f419f8`) added "fresh-repo" workarounds to `deploy.yml`, `.gitignore`, `.prettierignore`, `eslint.config.ts`. Per "use blueprint2 as-is + build on top," revert as part of this branch:

- `.github/workflows/deploy.yml` → blueprint-2.0 verbatim
- `.gitignore` → restore `convex/_generated/` entry
- `.prettierignore` → drop `convex/_generated/` (now gitignored)
- `eslint.config.ts` → keep cli/ exclusion (cvault-specific, not a CI hack)
- `git rm --cached convex/_generated/`

After revert: CI requires `CONVEX_DEPLOY_KEY` to codegen. User sets the secret as part of Track C.

## Process

1. Branch `feat/production-deployment` (created)
2. Land revert + Track A + Track B on branch (parallel agents)
3. Dual review (CC PR + Superpowers Code) on the diff
4. Fix findings via builder
5. Open PR
6. User runs Track C checklist
7. Merge PR → auto-deploy fires via existing `deploy.yml`

## Rollback strategy

If anything blows up post-merge:

- Backend: Convex preserves prior deployments; `npx convex deploy --rollback` reverts.
- Frontend: Cloudflare Pages keeps previous deploys; one-click revert in CF dashboard.
- CLI: Homebrew users on prior version unaffected; `brew upgrade cvault` is opt-in.
