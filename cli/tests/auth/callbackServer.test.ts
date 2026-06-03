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
 */
import { describe, expect, it } from 'vitest'

import { startCallbackServer } from '../../src/auth/callbackServer'

describe('startCallbackServer', () => {
  it('binds 127.0.0.1 on a random free port', async () => {
    const handle = await startCallbackServer({ expectedState: 'st1', timeoutMs: 1_000 })
    expect(handle.port).toBeGreaterThan(0)
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('resolves with code + state on a valid GET redirect and returns 200 HTML', async () => {
    const handle = await startCallbackServer({ expectedState: 'st-abc', timeoutMs: 5_000 })
    const url = `http://127.0.0.1:${String(handle.port)}/?code=abc123&state=st-abc`
    const resp = await fetch(url)
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('You can close this tab')
    const result = await handle.result
    expect(result).toEqual({ code: 'abc123', state: 'st-abc' })
  })

  it('returns 400 on mismatched state and does not settle the result', async () => {
    const handle = await startCallbackServer({ expectedState: 'real-state', timeoutMs: 200 })
    const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/?code=x&state=wrong`)
    expect(resp.status).toBe(400)
    const text = await resp.text()
    expect(text).toBe('state mismatch')
    // Result should NOT be settled yet — send a correct request to clean up.
    await fetch(`http://127.0.0.1:${String(handle.port)}/?code=good&state=real-state`)
    await expect(handle.result).resolves.toMatchObject({ code: 'good', state: 'real-state' })
  })

  it('returns 400 on missing code or state', async () => {
    const handle = await startCallbackServer({ expectedState: 'st', timeoutMs: 200 })
    // Only state, no code
    const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/?state=st`)
    expect(resp.status).toBe(400)
    const text = await resp.text()
    expect(text).toBe('missing code or state')
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('returns 405 on non-GET methods', async () => {
    const handle = await startCallbackServer({ expectedState: 'st', timeoutMs: 200 })
    const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/`, { method: 'POST' })
    expect(resp.status).toBe(405)
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('rejects with authorization error when ?error param is present', async () => {
    const handle = await startCallbackServer({ expectedState: 'st', timeoutMs: 5_000 })
    const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/?error=access_denied`)
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('You can close this tab')
    await expect(handle.result).rejects.toThrow(/access_denied/)
  })

  it('rejects with a timeout error after the configured window', async () => {
    const handle = await startCallbackServer({ expectedState: 'st', timeoutMs: 50 })
    await expect(handle.result).rejects.toThrow(/timed out/i)
  })

  it('rejects state values of a different length without throwing', async () => {
    // timingSafeEqual only works on equal-length buffers; the wrapper must
    // short-circuit length mismatches first.
    const handle = await startCallbackServer({ expectedState: 'longer-state', timeoutMs: 200 })
    const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/?code=x&state=short`)
    expect(resp.status).toBe(400)
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('cancel() stops the server, settles the result, and refuses further connections', async () => {
    const handle = await startCallbackServer({ expectedState: 'st', timeoutMs: 60_000 })
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
    // After cancel, fetching should fail (connection refused).
    await expect(
      fetch(`http://127.0.0.1:${String(handle.port)}/?code=x&state=st`)
    ).rejects.toThrow()
  })
})
