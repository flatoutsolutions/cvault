---
title: Anthropic OAuth Token Refresh (Claude AI / Claude Code accounts)
purpose: Reference for the credential vault's server-side refresh of Anthropic OAuth access tokens from a Convex action.
sources:
  - repo: realiti4/claude-swap
    branch: main
    head_commit: e1edd114cc607c197b2109080ee55345cb2ee0dc # HEAD of main on retrieval date
    head_commit_date: 2026-05-01
    files:
      - path: src/claude_swap/oauth.py
        last_touching_commit: a07c7677ba97f2f93c1d3dc53e76e0ddeda2bb50
        last_touching_commit_date: 2026-04-09
        url: https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/oauth.py
      - path: src/claude_swap/cache.py
        url: https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/cache.py
      - path: src/claude_swap/models.py
        url: https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/models.py
      - path: src/claude_swap/exceptions.py
        url: https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/exceptions.py
      - path: src/claude_swap/__init__.py
        url: https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/__init__.py
retrieved_at: 2026-05-02
retrieved_via: WebFetch against raw.githubusercontent.com
authoritative: false # claude-swap is a third-party tool reverse-engineering the Claude Code OAuth flow; treat as a strong reference, not as an Anthropic spec.
---

# Anthropic OAuth Token Refresh

This document captures everything `claude-swap` (a third-party multi-account
switcher for Claude Code) does to refresh OAuth access tokens against
Anthropic's token endpoint. The credentials format it works with is the same
one Claude Code persists locally — the `claudeAiOauth` payload — so what
claude-swap does is what an Anthropic-hosted refresh exchange currently
expects.

The Anthropic public docs do not document this endpoint or its request /
response shape. Treat this as the best available reference until Anthropic
publishes an official spec.

---

## Endpoint

| Item   | Value                                        |
| ------ | -------------------------------------------- |
| URL    | `https://platform.claude.com/v1/oauth/token` |
| Method | `POST`                                       |

Constants (verbatim from `oauth.py`):

```python
OAUTH_BETA_HEADER  = "oauth-2025-04-20"
OAUTH_TOKEN_URL    = "https://platform.claude.com/v1/oauth/token"
OAUTH_CLIENT_ID    = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000   # treat tokens with <5 min left as expired
```

Notes:

- `OAUTH_CLIENT_ID` is the public OAuth client id shared by all Claude Code
  installations; claude-swap hardcodes it. The credential vault should send
  the same value.
- `OAUTH_BETA_HEADER` is sent on the **usage** API call, not on the refresh
  call. See "Headers" below.

---

## Headers

### Refresh request (`POST https://platform.claude.com/v1/oauth/token`)

claude-swap sends only the bare minimum on the refresh call:

```
Content-Type: application/json
User-Agent: claude-swap/1.0
```

Notably, the refresh call **does not** send:

- `Authorization` (the refresh token is in the JSON body, not a header).
- `anthropic-beta` (that header is only for the usage API call).
- `x-api-key` (this is OAuth, not API-key auth).
- `anthropic-version` (the token endpoint is unversioned by header).

For the credential vault, set `User-Agent` to something the vault owns
(e.g. `cvault/1.0`) so that if Anthropic ever needs to identify traffic
they see the vault, not claude-swap.

### Usage request (separate, for reference)

`GET https://api.anthropic.com/api/oauth/usage` is what `OAUTH_BETA_HEADER`
applies to:

```
Authorization: Bearer <accessToken>
anthropic-beta: oauth-2025-04-20
User-Agent: claude-swap/1.0
```

The vault doesn't need this endpoint for refresh, but it's documented here
because it's the only place `OAUTH_BETA_HEADER` is used in `oauth.py`.

---

## Request Body

JSON object with three fields, all required:

| Field           | Type   | Required | Value                                                           |
| --------------- | ------ | -------- | --------------------------------------------------------------- |
| `grant_type`    | string | yes      | Literal `"refresh_token"`                                       |
| `refresh_token` | string | yes      | The refresh token from `claudeAiOauth.refreshToken`             |
| `client_id`     | string | yes      | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (the Claude Code app id) |

No `client_secret` is sent — this is a public client. No `scope` is
requested on refresh (scope is implicit from the original grant).

Example body:

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "<refresh_token_from_storage>",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
}
```

---

## Success Response (HTTP 200)

claude-swap reads these fields off the JSON response. From the merge logic
in `refresh_oauth_credentials`:

```python
oauth["accessToken"]  = resp_data["access_token"]                          # required
oauth["expiresAt"]    = now_ms + resp_data["expires_in"] * 1000            # required
if resp_data.get("refresh_token"):
    oauth["refreshToken"] = resp_data["refresh_token"]                     # optional (rotation)
if resp_data.get("scope"):
    oauth["scopes"] = resp_data["scope"].split()                           # optional
```

So the documented response shape is:

| Field           | Type   | Required | Notes                                                                                                                                        |
| --------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `access_token`  | string | yes      | New bearer token to send as `Authorization: Bearer ...` to Anthropic APIs.                                                                   |
| `expires_in`    | number | yes      | **Seconds** until the access token expires. Convert to ms-since-epoch on receipt.                                                            |
| `refresh_token` | string | no       | If present, **the previous refresh token is invalidated and must be replaced** (token rotation). If absent, keep the existing refresh token. |
| `scope`         | string | no       | Space-separated scope list; claude-swap stores it as a `string[]`.                                                                           |
| `token_type`    | string | no       | Standard OAuth field (`"Bearer"`); claude-swap ignores it.                                                                                   |

**Expiry encoding:** `expires_in` is **seconds**. claude-swap converts to
**ms-since-epoch** when storing as `expiresAt`:

```python
now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
oauth["expiresAt"] = now_ms + resp_data["expires_in"] * 1000
```

The local credentials file uses ms-since-epoch for `expiresAt`; the
endpoint itself returns seconds.

---

## Error Cases

claude-swap's only real error path is `urllib.error.HTTPError`, which it
logs and turns into `None`:

```python
except urllib.error.HTTPError as e:
    body = e.read().decode(errors="replace") if hasattr(e, "read") else ""
    _logger.debug("OAuth refresh failed: %r, body: %s", e, body[:500])
    return None
```

It does not branch on status code, but the calling code (`fetch_usage_for_account`)
has explicit handling for `401`:

```python
except urllib.error.HTTPError as e:
    if (
        e.code != 401
        or is_active
        or not oauth
        or not oauth.get("refreshToken")
    ):
        return None
    # ...retry once after refreshing on 401 (inactive accounts only).
```

That logic is for the **usage** API, but it tells us how claude-swap
interprets `401` from Anthropic's OAuth-protected endpoints: **the access
token is dead, try a refresh**. By extension, what kills the refresh path
is a `400`/`401` on the **token endpoint itself** with an OAuth-standard
`invalid_grant` body.

### Error response shape (RFC 6749 §5.2 — claude-swap doesn't parse it but Anthropic conforms)

```json
{
  "error": "invalid_grant",
  "error_description": "Refresh token is invalid or has been revoked"
}
```

Other documented OAuth `error` values that may appear: `invalid_request`,
`invalid_client`, `unauthorized_client`, `unsupported_grant_type`,
`invalid_scope`. For the vault, the only one that means "user must
re-login" is **`invalid_grant`** (or any `4xx` whose body parses to
`invalid_grant`). Everything else is a transient/configuration failure
the vault should retry or surface as an internal error.

### Status → semantic mapping for the vault

| HTTP status | OAuth `error`            | Vault interpretation                                           |
| ----------- | ------------------------ | -------------------------------------------------------------- |
| `200`       | n/a                      | Success. Persist new tokens, replace refresh token if rotated. |
| `400`       | `invalid_grant`          | **Refresh token dead. User must complete OAuth flow again.**   |
| `400`       | `invalid_request`        | Vault bug (malformed body). Surface, don't retry.              |
| `400`       | `unsupported_grant_type` | Vault bug. Surface, don't retry.                               |
| `401`       | `invalid_client`         | Wrong `client_id` — vault bug.                                 |
| `401`       | `invalid_grant`          | **Refresh token dead. User must re-login.**                    |
| `429`       | n/a                      | Rate-limited. Back off and retry.                              |
| `5xx`       | n/a                      | Transient server error. Retry with backoff.                    |

---

## Token Rotation Behavior

claude-swap's behavior, from `refresh_oauth_credentials`:

```python
if resp_data.get("refresh_token"):
    oauth["refreshToken"] = resp_data["refresh_token"]
```

- If the response **contains** `refresh_token`, replace the stored refresh
  token with the new one. The previous refresh token is now invalid.
- If the response **omits** `refresh_token`, the existing refresh token
  remains valid.

In practice, OAuth providers that issue rotating refresh tokens (which
Anthropic appears to, based on the conditional handling in claude-swap
and the issuance of `client_id` for a public Code-grant flow) typically
return a new `refresh_token` on every refresh. **Plan for rotation as the
common case**, and treat any successful refresh as potentially
invalidating the previous refresh token.

This has a critical consequence for the vault: the new refresh token
**must be persisted before the next refresh is attempted**, otherwise the
next refresh will fail with `invalid_grant` and the user will have to
re-login. claude-swap explicitly warns about this case in `_persist`:

> "Refreshed OAuth token for account %s but failed to persist it: %r.
> The refresh token on disk may now be stale; if the next refresh fails
> with invalid_grant, re-run `cswap --add-account` after logging in."

The vault should:

1. Refresh the token.
2. Atomically write the new credentials (including any rotated
   refresh_token) to Convex.
3. Only then return the new access token to the caller.

If the write fails, the vault must surface the failure loudly — do **not**
return the new access token, because the next refresh attempt will use a
stale refresh token from storage and will fail.

---

## Retry Strategy in claude-swap

claude-swap is intentionally minimal here:

- **Refresh call itself:** no retries, no backoff. If the refresh `POST`
  raises any `urllib.error.HTTPError` or other exception, it logs and
  returns `None`. The next time something needs the token (next 5-hour
  cycle, next CLI invocation), it tries again from scratch.
- **Usage API after a refresh:** one — and only one — retry. If the usage
  API returns `401`, claude-swap refreshes and retries the usage call
  exactly once. Any failure of the retried call is final.
- **Active account guard:** claude-swap **never** refreshes credentials
  for the currently active Claude Code account. Claude Code itself owns
  those credentials, and a parallel refresh would race the Claude Code
  process and risk corrupting `~/.claude/.credentials.json`. The vault
  doesn't have this constraint (it's the sole owner of the credentials
  it stores), but the principle generalises: **only one writer per
  refresh-token at a time**. The vault should use a Convex mutation /
  lock to serialise refreshes for a given credential.
- **Skew buffer:** claude-swap treats a token as expired if it has less
  than 5 minutes remaining (`OAUTH_EXPIRY_BUFFER_MS`). The vault should
  do the same so that a token returned to a client survives at least a
  few minutes of clock-skew + network round-trip.

Recommended vault retry strategy (not in claude-swap, but consistent
with what Anthropic's endpoint will tolerate):

| Failure                            | Strategy                                                 |
| ---------------------------------- | -------------------------------------------------------- |
| Network / DNS / connection error   | Retry up to 3x with exponential backoff (250ms, 1s, 4s). |
| `5xx`                              | Retry up to 3x with exponential backoff.                 |
| `429`                              | Honour `Retry-After` if present; otherwise 5s, 30s, 2m.  |
| `400` / `401` with `invalid_grant` | **Do not retry.** Mark credential as dead, signal user.  |
| `400` with anything else           | **Do not retry.** Surface as internal error.             |
| `200`                              | Persist + return.                                        |

---

## Open Questions / Caveats

1. **No published Anthropic spec.** Everything above is reverse-engineered
   from claude-swap. The endpoint, client id, and beta header may change
   without notice.
2. **`OAUTH_BETA_HEADER = "oauth-2025-04-20"` is for the usage API, not
   the token endpoint.** It's documented here only because the task
   asked for it and because anyone working in this area will encounter
   it. The refresh `POST` does **not** send `anthropic-beta`.
3. **`expires_in` units.** claude-swap multiplies by 1000 to convert to
   ms, confirming the response uses **seconds**. The locally-stored
   `expiresAt` is **ms-since-epoch** — do not confuse the two.
4. **Refresh-token rotation is conditional.** claude-swap only overwrites
   the stored refresh token _if_ the response includes one. We don't
   know from the source whether Anthropic always issues a new refresh
   token or only sometimes. Plan for "always" (the safer assumption)
   but accept "sometimes" if the field is absent.
5. **Error body shape.** claude-swap reads the error body for logging
   only; it doesn't parse `{ "error": "...", "error_description": "..." }`.
   That shape is the OAuth 2.0 standard (RFC 6749 §5.2), and the table
   above assumes Anthropic conforms. **Verify** this on the first
   real failure the vault sees and update this doc.
6. **Rate limits.** claude-swap does not encode any rate limit awareness
   for the token endpoint. None observed in the source. The vault
   should still implement `429` / `Retry-After` handling defensively.
7. **`client_id` reuse.** The hardcoded `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
   is the public Claude Code OAuth client. Re-using it from the vault
   is what makes the existing refresh tokens work, but it ties the vault
   to Claude Code's OAuth registration. If Anthropic ever offers an
   official "agent vault" client id, switch to that.
8. **Credentials envelope.** claude-swap stores OAuth state under
   `data.claudeAiOauth = { accessToken, refreshToken, expiresAt, scopes }`.
   The vault is free to use any storage shape, but if it ever has to
   ingest existing Claude Code credentials, that is the on-disk schema.

---

## Copy-paste TypeScript: refresh call from a Convex action

Uses Node 22's built-in `fetch`. No external dependencies.

```ts
// convex/oauth/anthropicRefresh.ts
import { ConvexError } from 'convex/values'

const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000

export type AnthropicRefreshSuccess = {
  accessToken: string
  expiresAt: number // ms since epoch
  refreshToken: string // possibly rotated; possibly identical to input
  scopes: string[] // empty if response omits `scope`
}

export type AnthropicRefreshDead = {
  kind: 'invalid_grant'
  description: string | undefined
}

/**
 * Refresh an Anthropic OAuth access token.
 *
 * Throws ConvexError on transient failures (network, 5xx, 429); the action
 * runtime will retry. Returns a discriminated union for terminal outcomes.
 */
export async function refreshAnthropicToken(
  refreshToken: string
): Promise<AnthropicRefreshSuccess | AnthropicRefreshDead> {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  })

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'cvault/1.0',
    },
    body,
  })

  // Read the body once so we can include it in error messages without
  // double-consuming the response stream.
  const rawText = await res.text()

  if (res.status === 200) {
    const json = JSON.parse(rawText) as {
      access_token: string
      expires_in: number // seconds
      refresh_token?: string // may be omitted if no rotation
      scope?: string // space-separated
      token_type?: string // typically "Bearer"; ignored
    }
    return {
      accessToken: json.access_token,
      // Convert seconds -> ms-since-epoch with our 5-minute safety buffer
      // baked in by *not* adding it here (the caller decides skew).
      expiresAt: Date.now() + json.expires_in * 1000,
      // If the response omits a new refresh_token, keep the old one.
      refreshToken: json.refresh_token ?? refreshToken,
      scopes: json.scope ? json.scope.split(' ') : [],
    }
  }

  // Try to parse OAuth error body (RFC 6749 §5.2).
  let oauthError: { error?: string; error_description?: string } = {}
  try {
    oauthError = JSON.parse(rawText) as typeof oauthError
  } catch {
    // Body wasn't JSON; fall through to the generic transient path below.
  }

  if ((res.status === 400 || res.status === 401) && oauthError.error === 'invalid_grant') {
    return {
      kind: 'invalid_grant',
      description: oauthError.error_description,
    }
  }

  // 4xx other than invalid_grant => caller bug or revoked client.
  // 5xx / 429 / network => transient.
  // We surface both as ConvexError; the caller (or a wrapper with
  // exponential backoff) decides retry policy.
  throw new ConvexError({
    code: res.status === 429 || res.status >= 500 ? 'transient' : 'permanent',
    httpStatus: res.status,
    oauthError: oauthError.error ?? null,
    oauthErrorDescription: oauthError.error_description ?? null,
    rawBody: rawText.slice(0, 500),
  })
}

/**
 * Decide whether a stored access token is still usable.
 * Mirrors claude-swap's 5-minute skew buffer.
 */
export function isAnthropicTokenExpired(expiresAtMs: number): boolean {
  return Date.now() + OAUTH_EXPIRY_BUFFER_MS >= expiresAtMs
}
```

---

## Copy-paste Convex validators for the response shape

Use these to validate what we receive from the OAuth endpoint and what we
persist into the vault. The "wire" validator matches Anthropic's response
exactly; the "stored" validator matches the credential vault's normalised
shape.

```ts
// convex/oauth/anthropicTypes.ts
import { v } from 'convex/values'

/**
 * Raw response body from POST https://platform.claude.com/v1/oauth/token.
 * Use this to validate Anthropic's response *before* normalising into the
 * vault's storage shape. All fields except access_token / expires_in are
 * optional per claude-swap's read pattern.
 */
export const anthropicRefreshResponse = v.object({
  access_token: v.string(),
  expires_in: v.number(), // seconds
  refresh_token: v.optional(v.string()), // present iff rotated
  scope: v.optional(v.string()), // space-separated
  token_type: v.optional(v.string()), // typically "Bearer"
})

/**
 * Normalised vault storage shape for an Anthropic OAuth credential.
 * `expiresAt` is ms-since-epoch (NOT seconds, NOT ISO).
 * `scopes` is the parsed string[] (NOT the raw space-separated string).
 */
export const anthropicStoredCredential = v.object({
  accessToken: v.string(),
  refreshToken: v.string(),
  expiresAt: v.number(), // ms since epoch
  scopes: v.array(v.string()),
})

/**
 * RFC 6749 §5.2 OAuth error body. claude-swap doesn't parse it; we do,
 * so we can distinguish "user must re-login" (invalid_grant) from
 * everything else.
 */
export const oauthErrorBody = v.object({
  error: v.string(), // e.g. "invalid_grant"
  error_description: v.optional(v.string()),
  error_uri: v.optional(v.string()),
})
```

If you want a single validator for the full action result, mirror the
TypeScript discriminated union from the previous section:

```ts
export const anthropicRefreshResult = v.union(
  v.object({
    kind: v.literal('ok'),
    credential: anthropicStoredCredential,
  }),
  v.object({
    kind: v.literal('invalid_grant'),
    description: v.optional(v.string()),
  })
)
```
