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

function setRows(value: Array<{ _id: string; domain: string; addedAtMs: number }> | undefined) {
  mockedUseQuery.mockReturnValue(value as never)
}

describe('DomainGuard', () => {
  it('renders nothing while Clerk is loading', () => {
    mockedUseUser.mockReturnValue({ isLoaded: false, isSignedIn: false, user: null } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows([])
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
    setRows(undefined)
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
    setRows([])
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
    setRows([])
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
    setRows([{ _id: '1', domain: 'acme.com', addedAtMs: 1 }])
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.getByText('protected')).not.toBeNull()
  })

  it('signed in + disallowed → blocked page', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'eve@gmail.com' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows([{ _id: '1', domain: 'flatout.solutions', addedAtMs: 1 }])
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
    expect(screen.getByText(/cvault is restricted/i)).not.toBeNull()
    expect(screen.getByRole('button', { name: /sign out/i })).not.toBeNull()
  })

  it('sign-out button calls Clerk signOut', () => {
    const signOut = vi.fn()
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: { emailAddress: 'eve@gmail.com' } },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut } as never)
    setRows([])
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('user with no primary email → blocked', () => {
    mockedUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { primaryEmailAddress: null },
    } as never)
    mockedUseClerk.mockReturnValue({ signOut: vi.fn() } as never)
    setRows([])
    render(
      <DomainGuard>
        <div>protected</div>
      </DomainGuard>
    )
    expect(screen.queryByText('protected')).toBeNull()
  })
})
