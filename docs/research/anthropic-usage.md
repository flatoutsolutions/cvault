# Anthropic OAuth Usage Endpoint — Reference Brief

Reverse-engineered from [`realiti4/claude-swap`](https://github.com/realiti4/claude-swap) (`src/claude_swap/oauth.py`, `switcher.py`, `__init__.py`). All references in this brief use claude-swap as of `main` at the time of writing.

This brief documents what we need to call `GET https://api.anthropic.com/api/oauth/usage` from a Convex scheduled action every 5 minutes per subscription, and how to persist the result into `subscriptions.usage5h` / `subscriptions.usage7d` per the cvault design spec.

---

## Endpoint

| Field                 | Value                                         |
| --------------------- | --------------------------------------------- |
| URL                   | `https://api.anthropic.com/api/oauth/usage`   |
| Method                | `GET`                                         |
| Body                  | none                                          |
| Auth                  | OAuth access token (Claude Code CLI token)    |
| Beta header           | required (`anthropic-beta: oauth-2025-04-20`) |
| Timeout (claude-swap) | 5 seconds (request), 10 seconds (refresh)     |

The OAuth access token is the `claudeAiOauth.accessToken` value Claude Code stores on disk. claude-swap derives `OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"` for the refresh flow but the `/usage` endpoint itself does not need the client id — only the bearer token.

---

## Headers

Exact set sent by claude-swap (no others):

```
Authorization: Bearer <accessToken>
anthropic-beta: oauth-2025-04-20
User-Agent: claude-swap/1.0
```

Notes:

- **`Authorization`** — only `Bearer <oat>` is documented; claude-swap does not try `x-api-key` or any other auth scheme on this endpoint. The token is the OAuth access token issued to the Claude Code CLI by the `https://platform.claude.com/v1/oauth/token` flow, NOT a regular Anthropic API key.
- **`anthropic-beta`** — required. Constant: `OAUTH_BETA_HEADER = "oauth-2025-04-20"` (defined in `src/claude_swap/oauth.py` line 14). Without this header, the endpoint will likely refuse the request (it is gated behind the OAuth beta).
- **`User-Agent`** — claude-swap sends `claude-swap/1.0`. We should send our own (e.g. `cvault/1.0`). Not strictly required but polite.
- **No `Content-Type`** because the request has no body.
- **No `anthropic-version`** header is sent by claude-swap on this endpoint. Anthropic's main `/v1/messages` API requires it; the OAuth-introspection endpoint apparently does not.

---

## Request

```
GET /api/oauth/usage HTTP/1.1
Host: api.anthropic.com
Authorization: Bearer <accessToken>
anthropic-beta: oauth-2025-04-20
User-Agent: cvault/1.0
```

### TypeScript fetch (Convex action)

Drop-in for a `convex/internal/usage.ts` action. Keep the literal `OAUTH_BETA_HEADER` value pinned in code — it is part of the contract.

```ts
// convex/lib/anthropicUsage.ts
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

export type RawUsageWindow = {
  utilization: number // 0..100, percent
  resets_at: string // ISO 8601 UTC, e.g. "2026-05-02T22:00:00Z"
}

export type RawUsageResponse = {
  five_hour?: RawUsageWindow
  seven_day?: RawUsageWindow
}

export type UsageFetchOutcome =
  | { kind: 'ok'; usage5h: NormalizedUsage | null; usage7d: NormalizedUsage | null }
  | { kind: 'tokenInvalid' } // 401 — refresh access token, retry once
  | { kind: 'rateLimited'; retryAfterMs: number | null } // 429
  | { kind: 'serverError'; status: number; body: string }
  | { kind: 'networkError'; error: string }

export type NormalizedUsage = {
  pct: number // 0..100, raw integer percent from Anthropic
  resetsAt: number // ms epoch (UTC), parsed from ISO 8601
  fetchedAt: number // ms epoch (UTC), set when we received the response
}

export async function fetchAnthropicUsage(accessToken: string): Promise<UsageFetchOutcome> {
  let res: Response
  try {
    res = await fetch(ANTHROPIC_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'User-Agent': 'cvault/1.0',
      },
      // Convex actions run in V8; AbortSignal.timeout is supported.
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    return { kind: 'networkError', error: String(e) }
  }

  if (res.status === 401) return { kind: 'tokenInvalid' }

  if (res.status === 429) {
    const retryAfterRaw = res.headers.get('retry-after')
    const retryAfterMs = retryAfterRaw
      ? Number.isNaN(Number(retryAfterRaw))
        ? null
        : Number(retryAfterRaw) * 1000
      : null
    return { kind: 'rateLimited', retryAfterMs }
  }

  if (res.status >= 500) {
    return { kind: 'serverError', status: res.status, body: await res.text() }
  }

  if (!res.ok) {
    return { kind: 'serverError', status: res.status, body: await res.text() }
  }

  const data = (await res.json()) as RawUsageResponse
  const fetchedAt = Date.now()

  const normalize = (w: RawUsageWindow | undefined): NormalizedUsage | null => {
    if (!w) return null
    const resetsAt = Date.parse(w.resets_at) // ISO 8601 -> ms epoch
    if (Number.isNaN(resetsAt)) return null
    return { pct: w.utilization, resetsAt, fetchedAt }
  }

  return {
    kind: 'ok',
    usage5h: normalize(data.five_hour),
    usage7d: normalize(data.seven_day),
  }
}
```

---

## Success Response (HTTP 200)

### Raw shape returned by Anthropic

claude-swap's `request_usage_data` returns the parsed JSON verbatim, and `build_usage_result` then reads only `five_hour` / `seven_day`, each with `utilization` and `resets_at`:

```jsonc
// /api/oauth/usage  -> 200 OK
{
  "five_hour": {
    "utilization": 42, // integer percent, 0..100
    "resets_at": "2026-05-02T22:00:00Z", // ISO 8601 UTC
  },
  "seven_day": {
    "utilization": 71,
    "resets_at": "2026-05-09T18:00:00Z",
  },
}
```

Confirmed claude-swap accesses (oauth.py `build_usage_result`, lines 160–180):

- `data["five_hour"]["utilization"]` — bound to display as `f"{pct:>3.0f}%"`, treated as a number in the 0–100 range.
- `data["five_hour"]["resets_at"]` — passed straight to `datetime.fromisoformat(resets_at)`, which only accepts ISO 8601 strings (i.e. **not** a ms-epoch number).
- Same two fields under `data["seven_day"]`.

Both top-level keys are treated as optional — `data.get("five_hour")` and `data.get("seven_day")` are guarded with `if h5:` / `if d7:`. We should not assume both are always present (e.g. accounts on Pro might not have a 7-day window).

`resets_at` format is **ISO 8601 UTC string**, not ms epoch. `datetime.fromisoformat` accepts the `+00:00` form and (in Python 3.11+) `Z`. In TypeScript, `Date.parse(...)` handles both.

### claude-swap normalized shape (display-layer)

This is what claude-swap stores in its 15s in-process cache and renders in the CLI. We do NOT need to copy this shape — the cvault spec wants ms-epoch fields persisted in Convex — but documenting it explains the snippets you'll see in claude-swap's source.

```jsonc
{
  "five_hour": {
    "pct": 42, // copied from utilization
    "countdown": "2h 15m", // derived: human-readable time until resets_at
    "clock": "22:00", // derived: local-time HH:MM (or "May 2 22:00" if not today)
  },
  "seven_day": {
    "pct": 71,
    "countdown": "6d 19h",
    "clock": "May 9 18:00",
  },
}
```

Derivation formulas (from `format_reset` in `oauth.py` lines 119–144):

- **`countdown`** = `resets_at - now()` formatted as:
  - `> 1d` → `"{d}d {h}h"`
  - `> 1h` → `"{h}h {m}m"`
  - else → `"{m}m"`
  - clamped to `0` if `resets_at` is in the past.
- **`clock`** = `resets_at.astimezone()` (local TZ) formatted as `"%H:%M"` if today, else `"%b %-d %H:%M"`.

For cvault we should compute countdown/clock at render time on the client (UI concern), and **persist only `{ pct, resetsAt, fetchedAt }`** as the spec already mandates. Keep the raw API shape in the lower layers; only normalize at the boundary.

---

## Convex schema mapping

The spec (`docs/superpowers/specs/2026-05-02-cvault-design.md` lines 112–117) defines:

```ts
usage5h: v.optional(v.object({
  pct: v.number(), resetsAt: v.number(), fetchedAt: v.number(),
})),
usage7d: v.optional(v.object({
  pct: v.number(), resetsAt: v.number(), fetchedAt: v.number(),
})),
```

Validators that round-trip the data we persist. Reuse via shared `usageWindowValidator`:

```ts
// convex/subscriptions/schema.ts (excerpt)
import { v } from 'convex/values'

export const usageWindowValidator = v.object({
  pct: v.number(), // 0..100, copied from Anthropic `utilization`
  resetsAt: v.number(), // ms epoch UTC, parsed from `resets_at`
  fetchedAt: v.number(), // ms epoch UTC, set when we received the response
})

// inside the subscriptions table:
//   usage5h: v.optional(usageWindowValidator),
//   usage7d: v.optional(usageWindowValidator),
```

Validator for the optional argument the internal mutation accepts when patching after a successful fetch (treat each window independently — if Anthropic only returned `five_hour`, only patch that):

```ts
// convex/subscriptions/internal.ts
import { v } from 'convex/values'

import { internalMutation } from '../_generated/server'
import { usageWindowValidator } from './schema'

export const patchUsage = internalMutation({
  args: {
    subId: v.id('subscriptions'),
    usage5h: v.optional(v.union(usageWindowValidator, v.null())),
    usage7d: v.optional(v.union(usageWindowValidator, v.null())),
  },
  handler: async (ctx, { subId, usage5h, usage7d }) => {
    const patch: Record<string, unknown> = {}
    if (usage5h !== undefined) patch.usage5h = usage5h ?? undefined
    if (usage7d !== undefined) patch.usage7d = usage7d ?? undefined
    await ctx.db.patch(subId, patch)
  },
})
```

`v.union(usageWindowValidator, v.null())` lets the action signal "explicitly absent" (e.g. Anthropic omitted the window) vs `undefined` ("don't touch this field on the existing doc"). Adjust to your taste; the spec only says `v.optional(v.object(...))`, so `null` is **not** a valid stored value — strip it before patching as shown above.

---

## Error Cases

claude-swap's behavior in `fetch_usage_for_account` (lines 193–256) and `fetch_usage` (lines 183–190):

| Status                        | claude-swap behavior                                                                                                                                                                                                                                                                                                                                                       | What it likely means                                                                                                                           | cvault recommendation                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **200**                       | Parse JSON, return normalized `{ five_hour?, seven_day? }`.                                                                                                                                                                                                                                                                                                                | Success.                                                                                                                                       | Patch `subscriptions.usage5h` / `usage7d`. Reset failure backoff.                                                                                                                                                                                                                                                                                     |
| **401**                       | If account is **inactive** AND has `refreshToken`, refresh via `https://platform.claude.com/v1/oauth/token` (POST `grant_type=refresh_token`), persist new creds, retry the usage call **once**. If retry also fails, return `None`. Active accounts (whose creds are owned by Claude Code CLI itself) are never refreshed by claude-swap — it returns `None` immediately. | Access token expired OR was revoked (subscription cancelled, user logged out everywhere, refresh token revoked).                               | Same pattern: try refresh, persist, retry once. If second 401, mark sub as `reloginRequired` per spec (`refreshLog.outcome = 'reloginRequired'`) and stop scheduling fetches until the user re-pastes credentials. The 401 alone does not distinguish "expired access token" from "cancelled subscription" — only a failed **refresh** disambiguates. |
| **429**                       | Not handled explicitly — falls into the generic `Exception` branch and is logged + suppressed (returns `None`). No `Retry-After` parsing.                                                                                                                                                                                                                                  | Per-account or global rate limit on the usage endpoint.                                                                                        | Honor `Retry-After` header (seconds). Schedule the next fetch after that delay. Do not fail-loud — this is expected under load.                                                                                                                                                                                                                       |
| **5xx**                       | Same generic `Exception` branch — logged + return `None`. No retries.                                                                                                                                                                                                                                                                                                      | Anthropic side issue.                                                                                                                          | Backoff (exponential), don't escalate. Keep last-known `usage5h` / `usage7d` in place.                                                                                                                                                                                                                                                                |
| **Network / timeout**         | Same generic branch. Request timeout is 5s.                                                                                                                                                                                                                                                                                                                                | Transient.                                                                                                                                     | Same as 5xx: silent retry on next 5-minute tick.                                                                                                                                                                                                                                                                                                      |
| **Other 4xx (400, 403, 404)** | Same generic branch.                                                                                                                                                                                                                                                                                                                                                       | 403 likely = beta header missing or account not authorized for OAuth. 400 = malformed request. 404 = endpoint moved (the URL is undocumented). | Log loudly. These are bugs in our integration, not transient. Surface via `refreshLog.outcome = 'failure'` with the body.                                                                                                                                                                                                                             |

### Retry summary

claude-swap retries **at most once**, only on **401**, and only after a successful **refresh**. There is no exponential backoff, no jitter, no 429 awareness, and no 5xx retry. We should be more careful since we run on a 5-minute cron per subscription:

1. **401 (token expired)** → refresh the access token using the refresh token, persist, retry **once**. Second 401 → mark `reloginRequired`, stop scheduling.
2. **429** → honor `Retry-After` (treat as seconds when integer-only; ms otherwise per RFC 7231 — be defensive). Schedule next fetch after the delay.
3. **5xx / network** → no inline retry. Let the next 5-minute tick handle it. Log to `refreshLog` as `failure`.
4. **2xx with no `five_hour` and no `seven_day`** → treat as ok-but-empty. Don't overwrite existing usage with `undefined`; leave the previous values in place.

---

## Rate Limits

claude-swap does **not** read any rate-limit headers from the response — it does not look for `Retry-After`, `anthropic-ratelimit-*`, or `x-ratelimit-*`. There is no documentation of which (if any) of Anthropic's standard rate-limit response headers this endpoint emits.

What we should do anyway, defensively:

- On 200, opportunistically read these headers if present and log them at debug level so we can characterize the limits empirically:
  - `retry-after`
  - `anthropic-ratelimit-requests-limit`
  - `anthropic-ratelimit-requests-remaining`
  - `anthropic-ratelimit-requests-reset`
  - `x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset` (legacy)
- On 429, **always** honor `Retry-After` if present (RFC 7231: integer seconds OR HTTP-date). If absent, fall back to a conservative 60s backoff.

At 5-minute cadence × N subscriptions per user, we are 12 calls/hour/sub — well under any plausible per-account limit. The risk is global concurrency if many users come online at once; consider jittering the cron offset per-subscription so we don't slam the endpoint on minute boundaries.

---

## Open Questions

These are gaps the claude-swap source does not answer; we should either confirm empirically or design defensively around them.

1. **Does the endpoint ever return `null` for `utilization`?** claude-swap reads it as a plain integer with `f"{pct:>3.0f}%"`. If Anthropic ever returns `null` (e.g. "unlimited" tier?), the format string would crash. Our normalizer should accept `number | null` and skip the field if `null`. Worth probing with a test call against a Pro account — Pro accounts may not have a 7-day window at all, hence the optional `seven_day` key.
2. **Is `utilization` always an integer 0–100?** The Python format spec `{pct:>3.0f}%` strips the decimal but works on floats too. The Convex validator is `v.number()` so either is fine; just don't assume integer.
3. **Is `resets_at` always UTC and always ISO 8601 with timezone?** `datetime.fromisoformat` will raise on a naive datetime in older Python; claude-swap doesn't catch that case here (it would log + return `None` via the outer `Exception` branch). Worth checking whether Anthropic emits `Z`, `+00:00`, or naive — `Date.parse` handles `Z` and `+00:00` but is undefined-behavior on naive ISO strings in some browsers (Convex actions run in V8 server-side, where it's UTC by default — but document this explicitly).
4. **What does 401 specifically mean — token expired vs subscription cancelled vs revoked?** The endpoint apparently does not distinguish via response body. claude-swap's heuristic ("if refresh succeeds, retry; if refresh also fails, give up") is the only signal available. We should mirror this and only set `reloginRequired` after a refresh-then-401 sequence.
5. **Are there any other top-level keys?** claude-swap reads only `five_hour` and `seven_day`. Anthropic could add `one_minute`, `one_hour`, `monthly`, etc. without notice. Keep our parser tolerant — ignore unknown keys, don't fail closed.
6. **Endpoint stability — `oauth-2025-04-20` beta suggests the contract may change.** Pin the literal beta header value in code (not config) and add a unit test that asserts it equals `"oauth-2025-04-20"` so a typo is caught at CI time. Watch claude-swap for changes to `OAUTH_BETA_HEADER` as an early signal that Anthropic bumped the beta.
7. **Concurrent token refresh.** claude-swap uses a `FileLock` around the persist callback. In Convex, two scheduled actions for the same sub could race on refresh. Per the spec, use the existing `refreshLeaseHolder` / `refreshLeaseUntil` fields on `subscriptions` to gate refresh attempts.

---

## Source pointers

- `src/claude_swap/oauth.py` — line 14 `OAUTH_BETA_HEADER`, lines 119–144 `format_reset`, lines 147–157 `request_usage_data`, lines 160–180 `build_usage_result`, lines 193–256 `fetch_usage_for_account`.
- `src/claude_swap/switcher.py` — lines 1022–1037 call site (`fetch_usage_for_account`), lines 1060–1080 consumer (string vs None vs dict handling, key access on `five_hour` / `seven_day`), line 65 `_USAGE_CACHE_TTL = 15`.
- `src/claude_swap/__init__.py` — only the package version export; no constants.
- `src/claude_swap/printer.py` — terminal styling only; no usage-response field access (as expected — the consumption is in `switcher.py`).
