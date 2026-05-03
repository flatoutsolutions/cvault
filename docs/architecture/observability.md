# cvault Observability — v1 Proposal

**Status:** proposal
**Owner:** unassigned
**Last reviewed:** 2026-05-03

## What we have today

- **Convex function logs** — `npx convex logs` and the Convex dashboard surface every query/mutation/action/cron invocation, plus `console.log/error` from inside them. Retained for the Convex tier's standard window.
- **`refreshLog` table** — every OAuth refresh attempt records `{ subscriptionId, attemptedAt, succeeded, error?, contentHashBefore?, contentHashAfter? }`. Errors are stored as redacted strings (token shapes scrubbed via `convex/subscriptions/redact.ts`).
- **`machineActivity` table** — append-only audit of `{ login, switch, refresh, remove, sync }` actions per Clerk session. Visible in the `/dashboard/machines` route.
- **No external alerting.** A failed refresh sits silently in `refreshLog` until a human looks at the dashboard.

## v1 recommendation

Two cheap additions, neither requiring a new vendor relationship:

### 1. Cloudflare Web Analytics (frontend)

Drop-in `<script>` tag in `frontend/src/routes/__root.tsx`. Free tier, no PII collection, no GDPR consent banner needed (Cloudflare's CWA is privacy-respecting by default — no cookies, no fingerprinting).

Provides:

- Page-load counts per route
- Real-time visitor counts
- Geographic distribution
- Performance metrics (LCP, FID, CLS, TTFB)

Setup: enable Web Analytics in the Cloudflare Pages project for `cvault`, copy the beacon `<script>` snippet, paste into `__root.tsx` head. ~5 minutes of setup, zero ongoing cost.

### 2. Daily refresh-error digest cron (backend)

New Convex cron that runs once per day (e.g., `06:00 Asia/Karachi`) and:

1. Queries `refreshLog` rows where `error IS NOT NULL` and `attemptedAt > now - 24h`.
2. Groups by subscription email and error class.
3. Renders a markdown digest.
4. If `MONITORING_SLACK_WEBHOOK_URL` env var is set, POSTs the digest to the configured Slack webhook. Otherwise, writes the digest to Convex logs and exits (no-op for users who haven't wired Slack).

Why digest-not-realtime: cvault is single-user-developer scale. Pager-style alerting on every refresh failure would be noise. A daily summary catches systemic issues (e.g., Anthropic rotated their OAuth client ID and 100% of refreshes started failing) without paging on transient flakiness.

Implementation footprint: one new file `convex/crons/dailyRefreshDigest.ts`, ~80 LOC, plus a one-line addition to `convex/crons.ts`.

## What we explicitly don't need yet

- **Sentry / Rollbar / Bugsnag** — error tracking platforms. Convex logs cover backend; the frontend is small enough that a browser console + the audit page suffice for v1.
- **Datadog / New Relic / Honeycomb** — APM. cvault's traffic profile is a few hundred requests per day at most. The Convex dashboard's built-in performance tab handles this.
- **OpenTelemetry / Jaeger / Tempo** — distributed tracing. cvault is one Convex deployment + one Cloudflare Pages bundle + one CLI. Not enough hops to justify trace plumbing.
- **PagerDuty / Opsgenie** — paging. Hobby-scale, no on-call.
- **Custom Grafana / Prometheus** — metrics. Convex's logs and the daily digest cron cover everything we'd graph at this scale.

Re-evaluate this list when any of these are true:

- Daily active users > 10
- Paid users > 0
- A single refresh failure causing real user impact within hours
- We add a second backend service

## Open questions

- **Domain for Cloudflare Web Analytics:** the beacon ties to a specific hostname. Default is `cvault.pages.dev`; if we add a custom domain (e.g. `cvault.dev`) we'd want CWA on both.
- **Slack webhook ownership:** who owns the channel the digest cron posts to? Blocker only if we ship the cron — for now the cron's "log to Convex" fallback is the actual default.
- **On-call rotation:** N/A at v1 ("no one yet, hobby-scale"). Revisit when the daily digest starts producing signal worth waking someone up for.

## Implementation order (post-prod-deploy)

1. Enable Cloudflare Web Analytics on the Pages project (~5 min after Track C lands).
2. Add the beacon `<script>` to `__root.tsx`.
3. Ship `dailyRefreshDigest` cron with the no-op fallback.
4. Decide on Slack channel + webhook (or skip indefinitely).

This document is the v1 plan. The cron implementation itself is out of scope for the production-deployment branch — that lands as a follow-up PR once prod is live and we have real refresh logs to validate the digest format against.
