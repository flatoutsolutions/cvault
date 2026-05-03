/**
 * Localhost HTTP listener used during `cvault login`.
 *
 * Per docs/research/clerk-convex-tanstack-integration.md §4-5: the dashboard
 * mints a Clerk sign-in token, then POSTs `{state, signInToken}` to a
 * 127.0.0.1 callback that the CLI is listening on. We accept ONE valid
 * POST then shut down.
 *
 * Hard rules:
 *  - bind 127.0.0.1, not 0.0.0.0 (no exposure beyond the local machine)
 *  - port: 0 — let the OS pick a free port; we read it via `server.port`
 *  - constant-time state comparison to defeat timing oracles
 *  - hard timeout (default 2 minutes) so a forgotten browser tab can't pin
 *    the listener forever
 */
import { timingSafeEqual } from 'node:crypto'

export interface CallbackResult {
  /** The Clerk sign-in token captured from the dashboard's POST. */
  signInToken: string
  /** True if the server was cancelled before a valid POST arrived. */
  cancelled?: boolean
}

export interface StartCallbackOptions {
  /** Random nonce the CLI generated and passed to the dashboard via the URL. */
  expectedState: string
  /** Total time the user has to complete the browser flow. Default 2 min. */
  timeoutMs?: number
}

export interface CallbackHandle {
  /** The bound port. The CLI uses this to construct the dashboard URL. */
  port: number
  /** Resolves with the captured sign-in token, or rejects on timeout/cancel. */
  result: Promise<CallbackResult>
  /** Stop the server early (e.g. on Ctrl-C or success-after-cancel). */
  cancel(): Promise<void>
}

interface CallbackBody {
  state?: unknown
  signInToken?: unknown
}

/**
 * Bind 127.0.0.1 on a random free port. Wait for ONE valid POST then shut down.
 * If no valid POST arrives within `timeoutMs`, reject and shut down.
 */
export function startCallbackServer(opts: StartCallbackOptions): CallbackHandle {
  const expectedStateBytes = new TextEncoder().encode(opts.expectedState)

  let resolveResult!: (r: CallbackResult) => void
  let rejectResult!: (err: Error) => void
  let settled = false
  // Build the user-visible promise. We attach a default no-op handler to it
  // SYNCHRONOUSLY so the runtime never reports it as "unhandled" if the
  // consumer chooses not to observe (e.g. tests calling `cancel()` to stop
  // the server without caring about the result). Consumers can still
  // attach their own .catch / await on `result`.
  const result: Promise<CallbackResult> = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = (r) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    rejectResult = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }
  })
  // Default observer — synchronous attachment is critical so it runs in the
  // same microtask the rejection scheduling does.
  result.catch((): undefined => undefined)

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      // CORS — dashboard origin (localhost:<port> or app.cvault.dev) POSTs
      // cross-origin to 127.0.0.1:<port>. Reflect Origin so any dashboard
      // origin works; only allow POST + Content-Type since that's all we accept.
      const origin = req.headers.get('origin') ?? '*'
      const corsHeaders: Record<string, string> = {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      }

      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders })
      }
      if (req.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: corsHeaders })
      }
      let body: CallbackBody
      try {
        body = (await req.json()) as CallbackBody
      } catch {
        return new Response('invalid JSON', { status: 400, headers: corsHeaders })
      }

      const state = typeof body.state === 'string' ? body.state : ''
      const signInToken = typeof body.signInToken === 'string' ? body.signInToken : ''
      if (!state || !signInToken) {
        return new Response('missing state or signInToken', { status: 400, headers: corsHeaders })
      }

      // Length-check first — `timingSafeEqual` requires equal-length buffers.
      const stateBytes = new TextEncoder().encode(state)
      if (stateBytes.byteLength !== expectedStateBytes.byteLength || !timingSafeEqual(stateBytes, expectedStateBytes)) {
        return new Response('state mismatch', { status: 400, headers: corsHeaders })
      }

      // Resolve before scheduling the shutdown so the queued 200 ships first.
      resolveResult({ signInToken })
      // Defer shutdown so the response body is fully written to the socket
      // before we yank the server out from under it. queueMicrotask is too
      // tight — Bun's HTTP layer sometimes hasn't flushed yet. 50ms is a
      // tradeoff between graceful shutdown and CLI exit latency.
      setTimeout(() => {
        void server.stop(true)
      }, 50)
      return new Response('ok', { status: 200, headers: corsHeaders })
    },
  })

  // Total timeout — never let a forgotten browser tab leave the listener up.
  const timeout = setTimeout(
    () => {
      rejectResult(new Error('Browser sign-in timed out. Re-run `cvault login` to try again.'))
      void server.stop(true)
    },
    opts.timeoutMs ?? 2 * 60 * 1000
  )

  // Clear the timeout when the result settles, regardless of how.
  void result.finally(() => {
    clearTimeout(timeout)
  })

  if (server.port === undefined) {
    // Should never happen for HTTP servers — port is only undefined on UDP.
    void server.stop(true)
    throw new Error('Bun.serve did not bind a port')
  }
  return {
    port: server.port,
    result,
    async cancel() {
      clearTimeout(timeout)
      await server.stop(true)
      // Settle the promise so awaiters don't hang. We resolve with a sentinel
      // (cancelled=true) rather than reject because rejecting a promise that
      // most callers ignore would generate spurious unhandled-rejection
      // warnings in tests. Callers that DO observe `result` should check for
      // `cancelled === true` and treat that as user-aborted.
      resolveResult({ signInToken: '', cancelled: true })
    },
  }
}
