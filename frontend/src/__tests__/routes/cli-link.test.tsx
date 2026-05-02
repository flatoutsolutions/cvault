/**
 * /cli/link route — CLI auth-flow callback.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §15.
 * Reference: docs/research/clerk-convex-tanstack-integration.md §4.
 *
 * Behavior under test (the route component, isolated from TanStack Router
 * file-route registration):
 *
 * - When signed-in, calls `api.cli.actions.startLink({state})` and POSTs
 *   {state, signInToken} to the localhost redirect URL.
 * - The body POST'd is JSON, with state echoed back (CSRF protection).
 * - Surfaces a "done" message on success.
 * - Surfaces a "need-signin" prompt when not signed in.
 * - Surfaces an error block when fetch fails.
 *
 * The actual route gets its `state`/`redirect` via `useSearch`; the
 * underlying component below accepts them as props for testability.
 *
 * Mocks:
 *   - `useUser`         from '@clerk/tanstack-react-start'
 *   - `useAction`       from 'convex/react'
 *   - `useSearch`       from '@tanstack/react-router'
 *   - global `fetch`
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Import AFTER mocks so the component picks up the stubbed hooks.
// eslint-disable-next-line import/first
import { CliLinkPage } from '../../routes/cli/link'

const startLinkMock = vi.fn()
const userState = {
  isLoaded: true,
  isSignedIn: true,
  user: { primaryEmailAddress: { emailAddress: 'alice@example.com' } },
}

vi.mock('@clerk/tanstack-react-start', () => ({
  useUser: () => userState,
}))

vi.mock('convex/react', () => ({
  useAction: () => startLinkMock,
}))

vi.mock('@tanstack/react-router', async () => {
  // Provide just the bits the component file imports. `createFileRoute`
  // is called at module load time, so we make it a no-op factory.
  return {
    createFileRoute: () => () => ({}),
    useSearch: () => ({
      redirect: 'http://127.0.0.1:53200/callback',
      state: 'nonce-abcdef',
    }),
  }
})

describe('/cli/link', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    startLinkMock.mockReset()
    fetchMock.mockReset()
    userState.isLoaded = true
    userState.isSignedIn = true
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mints a sign-in token and POSTs it to the localhost redirect when signed in', async () => {
    startLinkMock.mockResolvedValue({ signInToken: 'tok_xyz123' })
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' })

    render(<CliLinkPage />)

    await waitFor(() => {
      expect(startLinkMock).toHaveBeenCalledWith({ state: 'nonce-abcdef' })
    })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:53200/callback')
    expect(options.method).toBe('POST')
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(options.body as string)).toEqual({
      state: 'nonce-abcdef',
      signInToken: 'tok_xyz123',
    })

    await waitFor(() => {
      expect(screen.getByText(/linked/i)).toBeTruthy()
    })
  })

  it('renders an error block when the localhost callback returns non-2xx', async () => {
    startLinkMock.mockResolvedValue({ signInToken: 'tok_xyz123' })
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' })

    render(<CliLinkPage />)

    await waitFor(() => {
      expect(screen.getByText(/linking failed/i)).toBeTruthy()
    })
    expect(screen.getByText(/500/)).toBeTruthy()
  })

  it('renders an error block when startLink throws', async () => {
    startLinkMock.mockRejectedValue(new Error('CLERK_BACKEND_ERROR'))
    render(<CliLinkPage />)

    await waitFor(() => {
      expect(screen.getByText(/linking failed/i)).toBeTruthy()
    })
    expect(screen.getByText(/CLERK_BACKEND_ERROR/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the sign-in prompt when the user is not signed in', () => {
    userState.isSignedIn = false
    render(<CliLinkPage />)
    expect(screen.getByText(/you need to sign in/i)).toBeTruthy()
    expect(startLinkMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not run before Clerk is loaded', () => {
    userState.isLoaded = false
    render(<CliLinkPage />)
    expect(startLinkMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('/cli/link redirect host validation', () => {
  // We re-import the route's `searchSchema` to gate the open-redirect.
  // The schema is what TanStack Router calls BEFORE the component mounts;
  // if it accepts an attacker URL, the dashboard happily POSTs the
  // freshly minted Clerk sign-in token to that URL. We use a dynamic
  // `await import()` so the schema's symbol can be renamed without
  // breaking the import line at the top of the file.
  // (See `searchSchema` export on `frontend/src/routes/cli/link.tsx`.)
  type SchemaWithParse = { parse: (input: unknown) => unknown }
  let validate: (s: Record<string, string>) => unknown

  beforeEach(async () => {
    const mod = (await import('../../routes/cli/link')) as { searchSchema: SchemaWithParse }
    validate = (s) => mod.searchSchema.parse(s)
  })

  const VALID_LOCALHOST = [
    'http://127.0.0.1:54321/callback',
    'http://127.0.0.1:65535/cb?x=1',
    'http://localhost:54321/callback',
    'http://[::1]:54321/callback',
  ]
  const INVALID = [
    // Different host
    'https://attacker.example.com/callback',
    'http://attacker.example.com/callback',
    // Subdomain attack: localhost.attacker.example.com is NOT localhost.
    'http://localhost.attacker.example.com/cb',
    // HTTPS-only check: spec requires plain HTTP because the listener
    // binds 127.0.0.1 over plain HTTP.
    'https://127.0.0.1:54321/callback',
    // Embedded credentials trick: per RFC 3986, `user:pass@host` puts
    // user/pass in userinfo. We reject any URL that has userinfo set
    // (the WHATWG URL parser populates `.username` / `.password`).
    'http://attacker:bob@127.0.0.1:54321/cb',
    'http://attacker@localhost:54321/cb',
    // Authority spoofing — non-loopback IPs are not "localhost" even
    // though they resemble it lexically.
    'http://0.0.0.0:54321/callback',
    'http://192.168.1.1:54321/callback',
    // javascript: URLs
    'javascript:alert(1)',
    // file: URLs
    'file:///etc/passwd',
  ]

  for (const url of VALID_LOCALHOST) {
    it(`accepts a localhost URL: ${url}`, () => {
      expect(() => validate({ redirect: url, state: 'nonce-abcdef' })).not.toThrow()
    })
  }

  for (const url of INVALID) {
    it(`rejects ${url}`, () => {
      expect(() => validate({ redirect: url, state: 'nonce-abcdef' })).toThrow()
    })
  }
})
