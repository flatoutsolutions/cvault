/**
 * Convex client wrapper with auto-JWT-refresh on 401.
 *
 * Wraps `ConvexHttpClient` with:
 *  - Type-safe `query`/`mutation`/`action` calls via the generated `api`
 *  - One-shot retry on auth errors: refresh the convex JWT, then retry
 *  - Dependency injection for testability — production code uses the real
 *    `ConvexHttpClient`, tests inject an in-memory fake
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7 +
 * docs/research/ts-bun-cli-tooling.md §4.5.
 */
import { ConvexHttpClient } from 'convex/browser'
import type { FunctionReference, OptionalRestArgs } from 'convex/server'

import { type MintResult, mintConvexJwt } from '../auth/clerkFapi'
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

/** JWT refresher — abstracted so tests can stub it. */
export type RefreshJwt = (session: SessionState) => Promise<MintResult>

export interface VaultClientOptions {
  /** Override the default `mintConvexJwt` for tests / dependency injection. */
  refreshJwt?: RefreshJwt
}

export class VaultClient {
  private readonly http: ConvexHttpClientLike
  private readonly refresh: RefreshJwt
  private session: SessionState

  constructor(session: SessionState, httpClient?: ConvexHttpClientLike, options: VaultClientOptions = {}) {
    this.session = session
    this.http = httpClient ?? this.buildDefaultClient(session)
    this.refresh = options.refreshJwt ?? mintConvexJwt
  }

  /** Build the production `ConvexHttpClient`. Test code overrides via the ctor arg. */
  private buildDefaultClient(session: SessionState): ConvexHttpClientLike {
    const client = new ConvexHttpClient(session.convexUrl)
    client.setAuth(session.convexJwt)
    return client
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
   * Refresh the session JWT, persist the new state, and update the underlying
   * client's auth header. Used internally by callWithRetry; exposed for
   * proactive refresh paths (e.g. when the cached JWT's `exp` is < 10s away).
   */
  async refreshAuth(): Promise<void> {
    const fresh = await this.refresh(this.session)
    this.session = {
      ...this.session,
      convexJwt: fresh.convexJwt,
      convexJwtExpiry: fresh.convexJwtExpiry,
    }
    this.http.setAuth(fresh.convexJwt)
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

/** Convenience: build a `VaultClient` from the on-disk session. */
export async function makeVaultClient(): Promise<VaultClient> {
  const { readSession } = await import('../auth/session')
  const session = await readSession()
  return new VaultClient(session)
}
