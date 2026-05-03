'use node'

/**
 * Thin wrapper around Anthropic's OAuth refresh + usage HTTP endpoints,
 * with a test seam (`__setAnthropicFetch`) so unit tests can inject a
 * stub instead of hitting the real network.
 *
 * URLs + headers + payload shape match Claude Code's OAuth flow
 * (see docs/research/anthropic-oauth-refresh.md). Spec §14 calls for
 * re-confirming these at impl time.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto'

export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20'
export const USER_AGENT = 'cvault/0.1.0 (+https://github.com/saadings/cvault)'

// ---------------------------------------------------------------------------
// Test seams. Production code never assigns these — only `*.test.ts` files do.
// ---------------------------------------------------------------------------

let _fetch: typeof fetch | undefined
let _randomBytes: ((n: number) => Buffer) | undefined

export function __setAnthropicFetch(stub: typeof fetch | undefined): void {
  _fetch = stub
}

export function __setRandomBytesForTest(stub: ((n: number) => Buffer) | undefined): void {
  _randomBytes = stub
}

function activeFetch(): typeof fetch {
  return _fetch ?? fetch
}

function activeRandomBytes(): (n: number) => Buffer {
  return _randomBytes ?? nodeRandomBytes
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export interface RefreshSuccess {
  ok: true
  accessToken: string
  refreshToken: string | null
  expiresIn: number
  scope: string | null
}

export interface RefreshHttpError {
  ok: false
  kind: 'http'
  status: number
  rawBody: string
}

export interface RefreshNetworkError {
  ok: false
  kind: 'network'
  message: string
}

export type RefreshResult = RefreshSuccess | RefreshHttpError | RefreshNetworkError

export async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  const fn = activeFetch()
  let resp: Response
  try {
    resp = await fn(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    })
  } catch (err: unknown) {
    return {
      ok: false,
      kind: 'network',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (!resp.ok) {
    const rawBody = await resp.text()
    return { ok: false, kind: 'http', status: resp.status, rawBody }
  }

  const json = (await resp.json()) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
    scope?: unknown
  }

  if (typeof json.access_token !== 'string' || typeof json.expires_in !== 'number') {
    return {
      ok: false,
      kind: 'http',
      status: resp.status,
      rawBody: 'malformed Anthropic response (missing access_token or expires_in)',
    }
  }

  return {
    ok: true,
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresIn: json.expires_in,
    scope: typeof json.scope === 'string' ? json.scope : null,
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface UsageBucket {
  pct: number
  resetsAtMs: number
}

export interface UsageSuccess {
  ok: true
  fiveHour: UsageBucket | undefined
  sevenDay: UsageBucket | undefined
}

export interface UsageHttpError {
  ok: false
  kind: 'http'
  status: number
  rawBody: string
}

export interface UsageNetworkError {
  ok: false
  kind: 'network'
  message: string
}

export type UsageResult = UsageSuccess | UsageHttpError | UsageNetworkError

interface UsageBucketRaw {
  utilization?: unknown
  resets_at?: unknown
}

interface UsageRaw {
  five_hour?: UsageBucketRaw
  seven_day?: UsageBucketRaw
}

function parseBucket(raw: UsageBucketRaw | undefined): UsageBucket | undefined {
  if (!raw) return undefined
  if (typeof raw.utilization !== 'number') return undefined
  const resetsAt = typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) : NaN
  if (Number.isNaN(resetsAt)) return undefined
  return { pct: raw.utilization, resetsAtMs: resetsAt }
}

export async function fetchUsage(accessToken: string): Promise<UsageResult> {
  const fn = activeFetch()
  let resp: Response
  try {
    resp = await fn(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': ANTHROPIC_BETA_HEADER,
        'User-Agent': USER_AGENT,
      },
    })
  } catch (err: unknown) {
    return {
      ok: false,
      kind: 'network',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (!resp.ok) {
    const rawBody = await resp.text()
    return { ok: false, kind: 'http', status: resp.status, rawBody }
  }

  const json = (await resp.json()) as UsageRaw
  return {
    ok: true,
    fiveHour: parseBucket(json.five_hour),
    sevenDay: parseBucket(json.seven_day),
  }
}

// ---------------------------------------------------------------------------
// Misc helpers re-exported for the actions module
// ---------------------------------------------------------------------------

export function generateHolderToken(): string {
  return activeRandomBytes()(16).toString('hex')
}
