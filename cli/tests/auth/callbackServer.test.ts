/**
 * Spec: §7 + clerk-convex-tanstack-integration.md §7.
 *
 * The CLI binds 127.0.0.1 on a random free port, accepts ONE valid POST
 * (state + signInToken), then shuts down. State validation is constant-time
 * to defeat timing oracles. We use a real `Bun.serve` in tests — the local
 * socket is free and we get end-to-end coverage of JSON parsing, state
 * checks, and shutdown.
 */
import { describe, expect, it } from 'vitest'

import { startCallbackServer } from '../../src/auth/callbackServer'

describe('startCallbackServer', () => {
  it('binds 127.0.0.1 on a random free port', async () => {
    const handle = startCallbackServer({ expectedState: 'st1', timeoutMs: 1_000 })
    expect(handle.port).toBeGreaterThan(0)
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('resolves with signInToken on a valid POST and returns 200', async () => {
    const handle = startCallbackServer({ expectedState: 'st-abc', timeoutMs: 5_000 })
    const url = `http://127.0.0.1:${String(handle.port)}/`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'st-abc', signInToken: 'sit_xyz' }),
    })
    expect(resp.status).toBe(200)
    const result = await handle.result
    expect(result).toEqual({ signInToken: 'sit_xyz' })
  })

  it('returns 400 on mismatched state and times out without resolving', async () => {
    const handle = startCallbackServer({ expectedState: 'real-state', timeoutMs: 100 })
    const url = `http://127.0.0.1:${String(handle.port)}/`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'wrong', signInToken: 'sit_xyz' }),
    })
    expect(resp.status).toBe(400)
    // Observe the timeout rejection so it doesn't leak as "unhandled".
    await expect(handle.result).rejects.toThrow(/timed out/i)
  })

  it('returns 400 on missing fields', async () => {
    const handle = startCallbackServer({ expectedState: 'st', timeoutMs: 200 })
    const url = `http://127.0.0.1:${String(handle.port)}/`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'st' }), // no signInToken
    })
    expect(resp.status).toBe(400)
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('returns 400 on invalid JSON', async () => {
    const handle = startCallbackServer({ expectedState: 'st', timeoutMs: 200 })
    const url = `http://127.0.0.1:${String(handle.port)}/`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    expect(resp.status).toBe(400)
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('returns 405 on non-POST methods', async () => {
    const handle = startCallbackServer({ expectedState: 'st', timeoutMs: 200 })
    const url = `http://127.0.0.1:${String(handle.port)}/`
    const resp = await fetch(url, { method: 'GET' })
    expect(resp.status).toBe(405)
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('rejects with a timeout error after the configured window', async () => {
    const handle = startCallbackServer({ expectedState: 'st', timeoutMs: 50 })
    await expect(handle.result).rejects.toThrow(/timed out/i)
  })

  it('rejects state values of a different length without throwing', async () => {
    // timingSafeEqual only works on equal-length buffers; the wrapper must
    // short-circuit length mismatches first.
    const handle = startCallbackServer({ expectedState: 'longer-state', timeoutMs: 200 })
    const url = `http://127.0.0.1:${String(handle.port)}/`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'short', signInToken: 'sit_xyz' }),
    })
    expect(resp.status).toBe(400)
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
  })

  it('cancel() stops the server, settles the result, and refuses further connections', async () => {
    const handle = startCallbackServer({ expectedState: 'st', timeoutMs: 60_000 })
    await handle.cancel()
    await expect(handle.result).resolves.toMatchObject({ cancelled: true })
    // After cancel, fetching should fail (connection refused).
    const url = `http://127.0.0.1:${String(handle.port)}/`
    await expect(
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'st', signInToken: 'x' }),
      })
    ).rejects.toThrow()
  })
})
