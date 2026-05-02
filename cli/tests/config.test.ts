/**
 * Spec: §7. CLI reads configuration from CVAULT_* env vars, fallback to
 * VITE_CONVEX_URL / CLERK_FRONTEND_API_URL (repo .env.local), then to
 * ~/.vault/config.json. No bundled defaults — missing values throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveConfig } from '../src/config'

const REQUIRED_KEYS = [
  'CVAULT_CONVEX_URL',
  'CVAULT_FRONTEND_API_URL',
  'CVAULT_DASHBOARD_URL',
  'VITE_CONVEX_URL',
  'CLERK_FRONTEND_API_URL',
]

describe('resolveConfig', () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    for (const k of REQUIRED_KEYS) delete process.env[k]
  })

  afterEach(() => {
    process.env = { ...envBackup }
  })

  it('throws a helpful error when no config sources are set', () => {
    expect(() => resolveConfig()).toThrow(/missing required configuration/)
  })

  it('respects CVAULT_CONVEX_URL', () => {
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://override.convex.cloud')
    vi.stubEnv('CVAULT_FRONTEND_API_URL', 'https://t.clerk.accounts.dev')
    vi.stubEnv('CVAULT_DASHBOARD_URL', 'https://app.example.com')
    expect(resolveConfig().convexUrl).toBe('https://override.convex.cloud')
  })

  it('respects CVAULT_FRONTEND_API_URL', () => {
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://c.convex.cloud')
    vi.stubEnv('CVAULT_FRONTEND_API_URL', 'https://other.clerk.accounts.dev')
    vi.stubEnv('CVAULT_DASHBOARD_URL', 'https://app.example.com')
    expect(resolveConfig().frontendApiUrl).toBe('https://other.clerk.accounts.dev')
  })

  it('respects CVAULT_DASHBOARD_URL', () => {
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://c.convex.cloud')
    vi.stubEnv('CVAULT_FRONTEND_API_URL', 'https://t.clerk.accounts.dev')
    vi.stubEnv('CVAULT_DASHBOARD_URL', 'https://app.cvault.dev')
    expect(resolveConfig().dashboardUrl).toBe('https://app.cvault.dev')
  })

  it('falls back to repo .env.local naming (VITE_CONVEX_URL / CLERK_FRONTEND_API_URL)', () => {
    vi.stubEnv('VITE_CONVEX_URL', 'https://repo.convex.cloud')
    vi.stubEnv('CLERK_FRONTEND_API_URL', 'https://repo.clerk.accounts.dev')
    vi.stubEnv('CVAULT_DASHBOARD_URL', 'http://localhost:3000')
    const c = resolveConfig()
    expect(c.convexUrl).toBe('https://repo.convex.cloud')
    expect(c.frontendApiUrl).toBe('https://repo.clerk.accounts.dev')
    expect(c.dashboardUrl).toBe('http://localhost:3000')
  })

  it('CVAULT_* takes precedence over repo aliases', () => {
    vi.stubEnv('VITE_CONVEX_URL', 'https://repo.convex.cloud')
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://override.convex.cloud')
    vi.stubEnv('CVAULT_FRONTEND_API_URL', 'https://t.clerk.accounts.dev')
    vi.stubEnv('CVAULT_DASHBOARD_URL', 'http://localhost:3000')
    expect(resolveConfig().convexUrl).toBe('https://override.convex.cloud')
  })
})
