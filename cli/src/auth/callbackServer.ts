/**
 * Localhost HTTP listener used during `cvault login`.
 *
 * The browser is redirected to `http://127.0.0.1:<port>/?code=…&state=…`
 * by the Clerk OAuth authorization endpoint after the user approves.
 * We accept ONE valid GET then shut down.
 *
 * Hard rules:
 *  - bind 127.0.0.1, not 0.0.0.0 (no exposure beyond the local machine)
 *  - FIXED pre-registered ports (OAUTH_REDIRECT_PORTS). Clerk's OAuth app
 *    exact-matches the redirect URI, so a random port can't be registered.
 *    We bind a known port, trying a small fallback list so a single
 *    port-in-use doesn't break login. Each port's `http://127.0.0.1:<port>/`
 *    must be registered as a redirect URI in the Clerk OAuth application.
 *  - constant-time state comparison to defeat timing oracles
 *  - hard timeout (default 2 minutes) so a forgotten browser tab can't pin
 *    the listener forever
 *
 * Uses `node:http` rather than `Bun.serve` so the server runs under both
 * Bun (CLI runtime) and Node (test runner), removing the Bun-only dependency
 * while keeping identical behaviour at runtime.
 */
import { timingSafeEqual } from 'node:crypto'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Loopback ports the CLI binds for the OAuth redirect, in preference order.
 * Each corresponding `http://127.0.0.1:<port>/` MUST be registered as a
 * redirect URI in the Clerk OAuth application — Clerk exact-matches the
 * redirect URI, so these cannot be random. The fallback list means a single
 * port already in use (e.g. by another `cvault login`) doesn't block sign-in.
 *
 * High ports from the IANA dynamic range (49152–65535) to avoid collisions
 * with common services. If you change this list, update the registered
 * redirect URIs in Clerk to match.
 */
export const OAUTH_REDIRECT_PORTS: readonly number[] = [52017, 52018, 52019, 52020]

export interface CallbackResult {
  /** The OAuth authorization code captured from the redirect. */
  code: string
  /** The state echoed back by the authorization server. */
  state: string
  /** True if the server was cancelled before a valid redirect arrived. */
  cancelled?: boolean
}

export interface StartCallbackOptions {
  /** Random nonce the CLI generated and passed to the authorization URL. */
  expectedState: string
  /** Total time the user has to complete the browser flow. Default 2 min. */
  timeoutMs?: number
  /**
   * Ports to try, in order. Defaults to {@link OAUTH_REDIRECT_PORTS}. Tests
   * override this (e.g. `[0]` for an OS-assigned ephemeral port) to avoid
   * colliding with the real registered ports.
   */
  ports?: readonly number[]
}

export interface CallbackHandle {
  /** The bound port. The CLI uses this to construct the redirect_uri. */
  port: number
  /** Resolves with the captured code+state, or rejects on timeout/error. */
  result: Promise<CallbackResult>
  /** Stop the server early (e.g. on Ctrl-C). */
  cancel(): Promise<void>
}

/** Write a minimal HTML response — used for the success and error pages. */
function htmlResponse(res: ServerResponse, msg: string): void {
  const body = `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:3rem">${msg}</body>`
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(body)
}

/**
 * Bind 127.0.0.1 on a random free port. Wait for ONE valid GET redirect
 * then shut down. If no valid redirect arrives within `timeoutMs`, reject
 * and shut down.
 *
 * Returns a Promise<CallbackHandle> that resolves once the server is
 * listening and the port is known. This is the Node-idiomatic pattern:
 * `server.listen()` is asynchronous — the bound port is not available
 * until the `listening` event fires.
 */
export function startCallbackServer(opts: StartCallbackOptions): Promise<CallbackHandle> {
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

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Only accept GET — the browser navigates here via redirect.
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain' })
      res.end('method not allowed')
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    const error = url.searchParams.get('error')
    if (error !== null) {
      rejectResult(new Error(`Authorization denied: ${error}`))
      htmlResponse(res, 'You can close this tab.')
      setTimeout(() => server.close(), 50)
      return
    }

    const code = url.searchParams.get('code') ?? ''
    const state = url.searchParams.get('state') ?? ''
    if (!code || !state) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('missing code or state')
      return
    }

    // Length-check first — `timingSafeEqual` requires equal-length buffers.
    const stateBytes = new TextEncoder().encode(state)
    if (
      stateBytes.byteLength !== expectedStateBytes.byteLength ||
      !timingSafeEqual(stateBytes, expectedStateBytes)
    ) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('state mismatch')
      return
    }

    // Resolve before scheduling the shutdown so the response body ships first.
    resolveResult({ code, state })
    htmlResponse(res, 'Signed in to cvault. You can close this tab.')
    // Defer shutdown so the response body is fully written to the socket
    // before we close the server. 50ms mirrors the original Bun approach.
    setTimeout(() => server.close(), 50)
  })

  const ports = opts.ports ?? OAUTH_REDIRECT_PORTS

  return new Promise<CallbackHandle>((resolveHandle, rejectHandle) => {
    let idx = 0

    const onListening = (): void => {
      server.removeListener('error', onError)
      const addr = server.address() as AddressInfo | null
      if (addr === null || typeof addr.port !== 'number') {
        server.close()
        rejectHandle(new Error('http.createServer did not bind a port'))
        return
      }

      // Total timeout — never let a forgotten browser tab leave the listener up.
      const timeout = setTimeout(
        () => {
          rejectResult(new Error('Browser sign-in timed out. Re-run `cvault login` to try again.'))
          server.close()
        },
        opts.timeoutMs ?? 2 * 60 * 1000
      )

      // Clear the timeout when the result settles, regardless of how.
      void result.finally(() => {
        clearTimeout(timeout)
      })

      resolveHandle({
        port: addr.port,
        result,
        async cancel() {
          clearTimeout(timeout)
          server.close()
          // Settle the promise so awaiters don't hang. We resolve with a sentinel
          // (cancelled=true) rather than reject because rejecting a promise that
          // most callers ignore would generate spurious unhandled-rejection
          // warnings in tests. Callers that DO observe `result` should check for
          // `cancelled === true` and treat that as user-aborted.
          resolveResult({ code: '', state: '', cancelled: true })
        },
      })
    }

    // On EADDRINUSE, fall through to the next port; any other error (or the
    // last port also busy) is fatal. The `listening` handler stays attached so
    // a later successful bind still resolves.
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE' && idx < ports.length - 1) {
        idx += 1
        tryNext()
        return
      }
      server.removeListener('listening', onListening)
      if (err.code === 'EADDRINUSE') {
        rejectHandle(
          new Error(
            `All cvault login callback ports are in use (${ports.join(', ')}). ` +
              'Close whatever is using them and re-run `cvault login`.'
          )
        )
      } else {
        rejectHandle(err)
      }
    }

    function tryNext(): void {
      const port = ports[idx]
      if (port === undefined) {
        rejectHandle(new Error('No callback ports configured'))
        return
      }
      server.listen(port, '127.0.0.1')
    }

    server.on('listening', onListening)
    server.on('error', onError)
    tryNext()
  })
}
