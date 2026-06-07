/**
 * Tests for the OAuth loopback callback server.
 *
 * The browser is redirected to `http://127.0.0.1:<port>/?code=…&state=…`
 * by the Clerk authorization endpoint. We drive the server with real HTTP
 * GETs so we get end-to-end coverage of URL parsing, state validation, and
 * shutdown without any Bun-specific globals.
 *
 * All tests run under Node (no Bun required) because the server uses
 * node:http internally.
 *
 * Port convention: every test that does NOT specifically exercise port
 * selection passes `ports: [0]` so the OS assigns a free ephemeral port.
 * The default `OAUTH_REDIRECT_PORTS` is a small fixed set; binding it across
 * sequential tests (whose servers close on a 50ms timer) and parallel CI
 * workers caused bind contention → slow binds, timeouts, and reused-port
 * races. Only the "binds a registered fixed port by default" test below
 * relies on the default set.
 */
import { type AddressInfo, createServer as createNetServer } from 'node:net'

import { describe, expect, it } from 'vitest'

import { OAUTH_REDIRECT_PORTS, startCallbackServer } from '../../src/auth/callbackServer'
import { OAuthAuthorizationDeniedError } from '../../src/auth/oauthPkce'

/** Occupy an OS-assigned loopback port; returns the port + a closer. */
async function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const blocker = createNetServer()
  await new Promise<void>((resolve) => {
    blocker.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const port = (blocker.address() as AddressInfo).port
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        blocker.close(() => {
          resolve()
        })
      }),
  }
}

describe('startCallbackServer', () => {
  it('binds one of the registered fixed ports by default', async () => {
    const handle = await startCallbackServer({ expectedState: 'st1', timeoutMs: 1_000 })
    expect(OAUTH_REDIRECT_PORTS).toContain(handle.port)
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('falls back to the next port when the first is in use', async () => {
    const blocker = await occupyPort()
    // First port busy → must fall through to the second (0 = OS-assigned, free).
    const handle = await startCallbackServer({ expectedState: 'st', timeoutMs: 500, ports: [blocker.port, 0] })
    expect(handle.port).not.toBe(blocker.port)
    expect(handle.port).toBeGreaterThan(0)
    await handle.cancel()
    await blocker.close()
  })

  it('rejects when every candidate port is in use', async () => {
    const blocker = await occupyPort()
    await expect(startCallbackServer({ expectedState: 'st', timeoutMs: 500, ports: [blocker.port] })).rejects.toThrow(
      /in use/i
    )
    await blocker.close()
  })

  it('resolves with code + state on a valid GET redirect and returns 200 HTML', async () => {
    const handle = await startCallbackServer({ expectedState: 'st-abc', timeoutMs: 5_000, ports: [0] })
    const url = `http://127.0.0.1:${String(handle.port)}/?code=abc123&state=st-abc`
    const resp = await fetch(url)
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('You can close this tab')
    const result = await handle.result
    expect(result).toEqual({ code: 'abc123', state: 'st-abc' })
  })

  it('returns 400 on mismatched state and does not settle the result', async () => {
    const handle = await startCallbackServer({ expectedState: 'real-state', timeoutMs: 200, ports: [0] })
    const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/?code=x&state=wrong`)
    expect(resp.status).toBe(400)
    const text = await resp.text()
    expect(text).toBe('state mismatch')
    // Result should NOT be settled yet — send a correct request to clean up.
    await fetch(`http://127.0.0.1:${String(handle.port)}/?code=good&state=real-state`)
    await expect(handle.result).resolves.toMatchObject({ code: 'good', state: 'real-state' })
  })

  it('returns 400 on missing code or state', async () => {
    const handle = await startCallbackServer({ expectedState: 'st', timeoutMs: 200, ports: [0] })
    // Only state, no code
    const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/?state=st`)
    expect(resp.status).toBe(400)
    const text = await resp.text()
    expect(text).toBe('missing code or state')
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('returns 405 on non-GET methods', async () => {
    const handle = await startCallbackServer({ expectedState: 'st', timeoutMs: 200, ports: [0] })
    const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/`, { method: 'POST' })
    expect(resp.status).toBe(405)
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('rejects with OAuthAuthorizationDeniedError when ?error param is present', async () => {
    const handle = await startCallbackServer({ expectedState: 'st', timeoutMs: 5_000, ports: [0] })
    const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/?error=access_denied`)
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('You can close this tab')
    await expect(handle.result).rejects.toBeInstanceOf(OAuthAuthorizationDeniedError)
    await expect(handle.result).rejects.toThrow(/access_denied/)
  })

  it('rejects with a timeout error after the configured window', async () => {
    const handle = await startCallbackServer({ expectedState: 'st', timeoutMs: 50, ports: [0] })
    await expect(handle.result).rejects.toThrow(/timed out/i)
  })

  it('rejects state values of a different length without throwing', async () => {
    // timingSafeEqual only works on equal-length buffers; the wrapper must
    // short-circuit length mismatches first.
    const handle = await startCallbackServer({ expectedState: 'longer-state', timeoutMs: 200, ports: [0] })
    const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/?code=x&state=short`)
    expect(resp.status).toBe(400)
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('cancel() stops the server and settles the result as cancelled', async () => {
    const handle = await startCallbackServer({ expectedState: 'st', timeoutMs: 60_000, ports: [0] })
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
    // Note: we intentionally do NOT assert that a subsequent fetch to the
    // (now-freed) port is refused. That port is ephemeral, and under parallel
    // test workers the OS can immediately rebind it to another callback
    // server, so the assertion is racy (a `Response` from the new listener
    // instead of a connection-refused). `cancel()` calls `server.close()` and
    // the cancelled result above is the deterministic guarantee of our code.
  })
})
