import { useClerk, useUser } from '@clerk/tanstack-react-start'
import { fireEvent, render, screen } from '@testing-library/react'
import { useQuery } from 'convex/react'
import { describe, expect, it, vi } from 'vitest'

import { DomainGuard } from '../DomainGuard'

vi.mock('@clerk/tanstack-react-start', () => ({
  useUser: vi.fn(),
  useClerk: vi.fn(),
}))
vi.mock('convex/react', () => ({ useQuery: vi.fn() }))

const mockedUseUser = vi.mocked(useUser)
const mockedUseClerk = vi.mocked(useClerk)
const mockedUseQuery = vi.mocked(useQuery)

type DomainRow = { _id: string; domain: string; addedAtMs: number }
type EmailRow = { _id: string; email: string; addedAtMs: number }

// DomainGuard calls `useQuery` twice in a fixed source order: first the
// domain list, then the email list. We mock by call order rather than by
// reference, because Convex's `anyApi` proxy returns a new Proxy on every
// property access — `api.X.queries.list === api.X.queries.list` is false,
// so reference-based dispatch in the mock is unreliable.
function setRows(opts: { domains?: DomainRow[] | undefined; emails?: EmailRow[] | undefined }) {
  mockedUseQuery
    .mockReset()
    .mockReturnValueOnce(opts.domains as never)
    .mockReturnValueOnce(opts.emails as never)
}

describe('DomainGuard', () => {
  it('renders nothing while Clerk is loading', () => {
    mockedUseUser.mockReturnValue({ isLoaded: false, isSignedIn: false, user: null } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows({ domains: [], emails: [] })
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
  })

  it('renders nothing while allowed-domains is loading', () => {
    mockedUseUser.mockReturnValue({ isLoaded: true, isSignedIn: true, user: null } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows({ domains: undefined, emails: [] })
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
  })

  it('renders nothing while allowed-emails is loading', () => {
    mockedUseUser.mockReturnValue({ isLoaded: true, isSignedIn: true, user: null } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows({ domains: [], emails: undefined })
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
  })

  it('renders children when signed out', () => {
    mockedUseUser.mockReturnValue({ isLoaded: true, isSignedIn: false, user: null } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows({ domains: [], emails: [] })
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.getByText('protected')).not.toBeNull()
  })

  it('signed in + allowed (bootstrap fallback)', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'alice@flatout.solutions' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows({ domains: [], emails: [] })
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.getByText('protected')).not.toBeNull()
  })

  it('signed in + matches a configured (non-bootstrap) domain', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'bob@acme.com' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows({ domains: [{ _id: '1', domain: 'acme.com', addedAtMs: 1 }], emails: [] })
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.getByText('protected')).not.toBeNull()
  })

  it('signed in + matches an explicit-email row (no domain match)', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'samuel.asseg@gmail.com' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    // Bootstrap-fallback covers flatout.solutions only; gmail.com is NOT
    // a configured domain. The explicit-email row covers samuel.
    setRows({ domains: [], emails: [{ _id: '1', email: 'samuel.asseg@gmail.com', addedAtMs: 1 }] })
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.getByText('protected')).not.toBeNull()
  })

  it('signed in + disallowed → blocked page (no domain or email match)', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'eve@gmail.com' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows({ domains: [{ _id: '1', domain: 'flatout.solutions', addedAtMs: 1 }], emails: [] })
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
    expect(screen.getByText(/cvault is restricted/i)).not.toBeNull()
    expect(screen.getByRole('button', { name: /sign out/i })).not.toBeNull()
  })

  it('blocked page lists the explicit-email allowlist when non-empty', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'eve@gmail.com' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows({
      domains: [{ _id: '1', domain: 'flatout.solutions', addedAtMs: 1 }],
      emails: [{ _id: 'e1', email: 'samuel.asseg@gmail.com', addedAtMs: 1 }],
    })
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    // Both the domain and the explicit email should appear so the
    // blocked user knows the full picture of who's allowed.
    expect(screen.getByText(/Explicit allowed emails/i)).not.toBeNull()
    expect(screen.getByText('samuel.asseg@gmail.com')).not.toBeNull()
  })

  it('sign-out button calls Clerk signOut', () => {
    const signOut = vi.fn()
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'eve@gmail.com' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut } as never)
    setRows({ domains: [], emails: [] })
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('user with no primary email → blocked page (not just empty render)', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: null },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows({ domains: [], emails: [] })
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
    // Confirm the blocked page is rendered, not just absence of protected
    // child (catch a regression that returns null instead of the error UI).
    expect(screen.getByText(/cvault is restricted/i)).not.toBeNull()
  })
})
