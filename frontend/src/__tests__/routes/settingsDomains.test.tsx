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

  it('add submits the typed domain trimmed + lowercased', async () => {
    mockedUseQuery.mockReturnValue([] as never)
    render(<DomainsPage />)
    const input = screen.getByLabelText(/add domain/i)
    // Zod schema trims + lowercases; mutation receives the canonical form.
    fireEvent.change(input, { target: { value: '  ACME.COM ' } })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await waitFor(() => {
      expect(addMock).toHaveBeenCalledWith({ domain: 'acme.com' })
    })
  })

  it('lowercases an uppercase domain on submit', async () => {
    mockedUseQuery.mockReturnValue([] as never)
    render(<DomainsPage />)
    fireEvent.change(screen.getByLabelText(/add domain/i), { target: { value: 'VALID.COM' } })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await waitFor(() => {
      expect(addMock).toHaveBeenCalledWith({ domain: 'valid.com' })
    })
  })

  it('shows inline error and does NOT submit when the domain has spaces', async () => {
    mockedUseQuery.mockReturnValue([] as never)
    render(<DomainsPage />)
    fireEvent.change(screen.getByLabelText(/add domain/i), { target: { value: 'no spaces here.com' } })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(await screen.findByText(/invalid domain format/i)).not.toBeNull()
    expect(addMock).not.toHaveBeenCalled()
  })

  it('shows inline error and does NOT submit when the input is empty', async () => {
    mockedUseQuery.mockReturnValue([] as never)
    render(<DomainsPage />)
    // Type then clear, so the form is "touched" with an empty value.
    fireEvent.change(screen.getByLabelText(/add domain/i), { target: { value: 'a' } })
    fireEvent.change(screen.getByLabelText(/add domain/i), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(await screen.findByText(/domain required/i)).not.toBeNull()
    expect(addMock).not.toHaveBeenCalled()
  })

  it('shows inline error and does NOT submit when the domain exceeds 253 chars', async () => {
    mockedUseQuery.mockReturnValue([] as never)
    render(<DomainsPage />)
    // 254-char value: 248 'a' + '.com' = 252 — extend so total > 253.
    const huge = 'a'.repeat(250) + '.com'
    expect(huge.length).toBe(254)
    fireEvent.change(screen.getByLabelText(/add domain/i), { target: { value: huge } })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(await screen.findByText(/domain too long/i)).not.toBeNull()
    expect(addMock).not.toHaveBeenCalled()
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
    // Use a value that PASSES the client-side Zod schema (well-formed
    // domain shape) so the mutation actually fires; the server-side
    // mock then throws to exercise the inline error-display path.
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
    fireEvent.change(screen.getByLabelText(/add domain/i), { target: { value: 'reserved.test' } })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))
    expect(await screen.findByText(/INVALID_DOMAIN/i)).not.toBeNull()
  })

  it('surfaces server CANNOT_REMOVE_OWN_DOMAIN error inline when remove throws', async () => {
    removeMock = vi.fn(() => {
      throw new Error('CANNOT_REMOVE_OWN_DOMAIN: You cannot remove the domain that your own email belongs to.')
    })
    mockedUseMutation.mockImplementation((ref) => {
      const name = refToName(ref)
      if (name.includes('add')) return addMock as never
      if (name.includes('remove')) return removeMock as never
      return vi.fn() as never
    })
    // Render a non-self-domain row so the Remove button is enabled. The
    // mocked remove still throws CANNOT_REMOVE_OWN_DOMAIN to exercise
    // the inline error-display path the user would see if a server-side
    // race made the row become a self-removal between query+click.
    mockedUseQuery.mockReturnValue([{ _id: '1', domain: 'someotherdomain.com', addedAtMs: 1 }] as never)
    render(<DomainsPage />)
    fireEvent.click(screen.getByRole('button', { name: /remove someotherdomain\.com/i }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /confirm/i }))
    expect(await screen.findByText(/CANNOT_REMOVE_OWN_DOMAIN/i)).not.toBeNull()
  })
})
