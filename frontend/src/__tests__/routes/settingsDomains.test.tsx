import { useUser } from '@clerk/tanstack-react-start'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useMutation, useQuery } from 'convex/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DomainsPage } from '../../routes/dashboard/settings/domains.lazy'

vi.mock('@clerk/tanstack-react-start', () => ({ useUser: vi.fn() }))
vi.mock('convex/react', () => ({ useQuery: vi.fn(), useMutation: vi.fn() }))

const mockedUseUser = vi.mocked(useUser)
const mockedUseQuery = vi.mocked(useQuery)
const mockedUseMutation = vi.mocked(useMutation)

// Convex `api.x.y.z` refs are Proxies — `String(ref)` can throw TypeError.
// Read the `Symbol.for('functionName')` symbol (or _functionPath/_name fallback)
// the same way frontend/src/__tests__/routes/dashboard.test.tsx does.
function refToName(ref: unknown): string {
  const r = ref as Record<string | symbol, unknown>
  if (typeof r._functionPath === 'string') return r._functionPath
  if (typeof r._name === 'string') return r._name
  const sym = Symbol.for('functionName')
  const v = r[sym]
  return typeof v === 'string' ? v : 'default'
}

let addMock = vi.fn()
let removeMock = vi.fn()

beforeEach(() => {
  addMock = vi.fn(() => Promise.resolve('jd_new_id'))
  removeMock = vi.fn(() => Promise.resolve(null))
  mockedUseMutation.mockImplementation((ref) => {
    const name = refToName(ref)
    if (name.includes('add')) return addMock as never
    if (name.includes('remove')) return removeMock as never
    return vi.fn() as never
  })
  mockedUseUser.mockReturnValue({
    user: { primaryEmailAddress: { emailAddress: 'alice@flatout.solutions' } },
  } as never)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('DomainsPage', () => {
  it('renders the current allowlist', () => {
    mockedUseQuery.mockReturnValue([
      { _id: '1', domain: 'flatout.solutions', addedAtMs: 1 },
      { _id: '2', domain: 'acme.com', addedAtMs: 2 },
    ] as never)
    render(<DomainsPage />)
    // The row is rendered as a <span> with font-mono. The description copy
    // also mentions "flatout.solutions" inside a <code>; assert via the
    // remove-button aria-label which is unambiguous.
    expect(screen.getByRole('button', { name: /remove flatout\.solutions/i })).not.toBeNull()
    expect(screen.getByRole('button', { name: /remove acme\.com/i })).not.toBeNull()
  })

  it('shows bootstrap-active hint when empty', () => {
    mockedUseQuery.mockReturnValue([] as never)
    render(<DomainsPage />)
    expect(screen.getByText(/bootstrap fallback/i)).not.toBeNull()
  })

  it('add submits the typed domain', async () => {
    mockedUseQuery.mockReturnValue([] as never)
    render(<DomainsPage />)
    const input = screen.getByLabelText(/add domain/i)
    fireEvent.change(input, { target: { value: '  ACME.COM ' } })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await waitFor(() => {
      expect(addMock).toHaveBeenCalledWith({ domain: '  ACME.COM ' })
    })
  })

  it('remove asks for confirmation then calls mutation', async () => {
    mockedUseQuery.mockReturnValue([{ _id: '1', domain: 'acme.com', addedAtMs: 1 }] as never)
    render(<DomainsPage />)
    fireEvent.click(screen.getByRole('button', { name: /remove acme\.com/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /confirm/i }))
    await waitFor(() => {
      expect(removeMock).toHaveBeenCalledWith({ id: '1' })
    })
  })

  it('disables remove on the row matching caller domain', () => {
    mockedUseQuery.mockReturnValue([
      { _id: '1', domain: 'flatout.solutions', addedAtMs: 1 },
      { _id: '2', domain: 'acme.com', addedAtMs: 2 },
    ] as never)
    render(<DomainsPage />)
    const flatBtn = screen.getByRole('button', { name: /remove flatout\.solutions/i })
    expect((flatBtn as HTMLButtonElement).disabled).toBe(true)
    const acmeBtn = screen.getByRole('button', { name: /remove acme\.com/i })
    expect((acmeBtn as HTMLButtonElement).disabled).toBe(false)
  })

  it('surfaces server validation error on add', async () => {
    addMock = vi.fn(() => {
      throw new Error('INVALID_DOMAIN: not a valid domain')
    })
    mockedUseMutation.mockImplementation((ref) => {
      const name = refToName(ref)
      if (name.includes('add')) return addMock as never
      return vi.fn() as never
    })
    mockedUseQuery.mockReturnValue([] as never)
    render(<DomainsPage />)
    fireEvent.change(screen.getByLabelText(/add domain/i), { target: { value: 'not a domain' } })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(await screen.findByText(/INVALID_DOMAIN/i)).not.toBeNull()
  })
})
