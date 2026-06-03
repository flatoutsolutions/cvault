/**
 * Convex client wrapper with auto-access-token-refresh on 401.
 *
 * Wraps `ConvexHttpClient` with:
 *  - Type-safe `query`/`mutation`/`action` calls via the generated `api`
 *  - One-shot retry on auth errors: refresh the OAuth access token, then retry
 *  - Dependency injection for testability — production code uses the real
 *    `ConvexHttpClient`, tests inject an in-memory fake
 *
 * Spec: docs/superpowers/plans/2026-06-03-cli-oauth-pkce.md §Task 14.
 */
import { ConvexHttpClient } from 'convex/browser'
import type { FunctionReference, OptionalRestArgs } from 'convex/server'

import { type OAuthTokens, refreshAccessToken } from '../auth/oauthPkce'
import { type SessionState, writeSession } from '../auth/session'
import { isAuthError } from './isAuthError'

/**
 * Subset of `ConvexHttpClient` we depend on. Defined as an interface so
 * tests can inject an in-memory fake without dragging the network.
 */
export interface ConvexHttpClientLike {
  query<Q extends FunctionReference<'query'>>(fn: Q, ...args: OptionalRestArgs<Q>): Promise<Q['_returnType']>
  mutation<M extends FunctionReference<'mutation'>>(fn: M, ...args: OptionalRestArgs<M>): Promise<M['_returnType']>
  action<A extends FunctionReference<'action'>>(fn: A, ...args: OptionalRestArgs<A>): Promise<A['_returnType']>
  setAuth(token: string): void
}

/** OAuth access token refresher — abstracted so tests can stub it. */
export type RefreshAccessToken = (opts: {
  frontendApiUrl: string
  clientId: string
  refreshToken: string
}) => Promise<OAuthTokens>

export interface VaultClientOptions {
  /** Override the default `refreshAccessToken` for tests / dependency injection. */
  refreshAccessToken?: RefreshAccessToken
}

export class VaultClient {
  private readonly http: ConvexHttpClientLike
  private readonly doRefresh: RefreshAccessToken
  private session: SessionState
  private readonly machineId: string

  constructor(
    session: SessionState,
    machineId: string,
    httpClient?: ConvexHttpClientLike,
    options: VaultClientOptions = {}
  ) {
    this.session = session
    this.machineId = machineId
    this.http = httpClient ?? this.buildDefaultClient(session)
    this.doRefresh = options.refreshAccessToken ?? refreshAccessToken
  }

  /**
   * Build the production `ConvexHttpClient`. Test code overrides via the ctor arg.
   *
   * Convex is authenticated with the **ID token**, not the OAuth access token.
   * Clerk's OAuth access-token JWT carries `client_id`/`scope` but NO `aud`
   * claim, so Convex's provider matching (which keys on `aud == applicationID`)
   * rejects it. The OIDC ID token carries `aud == <OAuth Client ID>` (matching
   * the `auth.config.ts` provider) plus `email`/`sub`, so it's the token Convex
   * can verify. Falls back to the access token only to satisfy the string type
   * when no id token is present (which shouldn't happen — we request `openid`).
   */
  private buildDefaultClient(session: SessionState): ConvexHttpClientLike {
    const client = new ConvexHttpClient(session.convexUrl)
    client.setAuth(session.idToken ?? session.accessToken)
    return client
  }

  /**
   * The user-visible machine label captured at `cvault login` time. Read
   * from the persisted session. May be `undefined` for sessions created
   * before the label was tracked.
   */
  get machineLabel(): string | undefined {
    return this.session.machineLabel
  }

  /**
   * Merge the session's `machineLabel` into the supplied args object. Used
   * by every command call site whose Convex action writes to
   * `machineActivity`, so the dashboard's "Machines" view can render a
   * human-readable label per machine instead of the opaque `machineId`.
   *
   * Centralizing this keeps the spread + optional-undefined dance in one
   * place — adding a new action call site only has to call
   * `client.withMeta({...})` rather than re-implementing the
   * conditional spread.
   */
  withMachineLabel<T extends Record<string, unknown>>(args: T): T & { machineLabel?: string } {
    if (this.session.machineLabel === undefined) return args
    return { ...args, machineLabel: this.session.machineLabel }
  }

  /**
   * Convenience: inject both `machineId` and optional `machineLabel` into
   * args. Every CLI action that writes a `machineActivity` row uses this.
   * The Convex actions accept `machineId: v.optional(v.string())` and fall
   * back to `resolveCallerSession(identity)` when absent.
   */
  withMeta<T extends Record<string, unknown>>(args: T): T & { machineId: string; machineLabel?: string } {
    return this.withMachineLabel({ ...args, machineId: this.machineId })
  }

  async query<Q extends FunctionReference<'query'>>(fn: Q, ...args: OptionalRestArgs<Q>): Promise<Q['_returnType']> {
    return this.callWithRetry(() => this.http.query(fn, ...args))
  }

  async mutation<M extends FunctionReference<'mutation'>>(
    fn: M,
    ...args: OptionalRestArgs<M>
  ): Promise<M['_returnType']> {
    return this.callWithRetry(() => this.http.mutation(fn, ...args))
  }

  async action<A extends FunctionReference<'action'>>(fn: A, ...args: OptionalRestArgs<A>): Promise<A['_returnType']> {
    return this.callWithRetry(() => this.http.action(fn, ...args))
  }

  /**
   * Refresh the OAuth access token, persist the updated session, and update
   * the underlying client's auth header. Used internally by callWithRetry;
   * exposed for proactive refresh paths (e.g. when the cached token's `exp`
   * is < 10s away).
   */
  async refreshAuth(): Promise<void> {
    const fresh = await this.doRefresh({
      frontendApiUrl: this.session.frontendApiUrl,
      clientId: this.session.clientId,
      refreshToken: this.session.refreshToken,
    })
    this.session = {
      ...this.session,
      accessToken: fresh.accessToken,
      accessTokenExpiry: fresh.accessTokenExpiry,
      refreshToken: fresh.refreshToken,
      ...(fresh.idToken !== undefined ? { idToken: fresh.idToken } : {}),
    }
    // Re-auth Convex with the refreshed ID token (see buildDefaultClient for
    // why the access token can't be used). The refresh_token grant returns a
    // fresh id_token because `openid` was granted at login.
    this.http.setAuth(fresh.idToken ?? this.session.idToken ?? fresh.accessToken)
    // Persist asynchronously — we don't want to block the in-flight call on
    // disk I/O if the OS is busy. Errors are swallowed: persistence failure
    // is logged elsewhere; the in-memory state is still correct.
    void writeSession(this.session).catch(() => undefined)
  }

  /**
   * Wrap a call with a single retry on auth errors. Non-auth errors fall
   * through; a second auth error after refresh propagates so the caller
   * surfaces "session expired — re-run cvault login".
   */
  private async callWithRetry<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (err) {
      if (!isAuthError(err)) throw err
      await this.refreshAuth()
      return await call()
    }
  }
}

/** Convenience: build a `VaultClient` from the on-disk session + machine id. */
export async function makeVaultClient(): Promise<VaultClient> {
  const { readSession } = await import('../auth/session')
  const { loadOrCreateMachineId } = await import('../auth/machineId')
  const session = await readSession()
  const machineId = await loadOrCreateMachineId()
  return new VaultClient(session, machineId)
}
