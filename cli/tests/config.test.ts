/**
 * Spec: §7. The CLI ships with bundled defaults for the prod deployment +
 * dashboard URLs, with env var overrides for dev/local-dev.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveConfig } from '../src/config'

describe('resolveConfig', () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    delete process.env.CVAULT_CONVEX_URL
    delete process.env.CVAULT_FRONTEND_API_URL
    delete process.env.CVAULT_DASHBOARD_URL
  })

  afterEach(() => {
    process.env = { ...envBackup }
  })

  it('falls back to bundled defaults when no env vars set', () => {
    const config = resolveConfig()
    expect(config.convexUrl).toMatch(/^https:\/\/.+\.convex\.cloud$/)
    expect(config.frontendApiUrl).toMatch(/^https:\/\/.+\.clerk\.accounts\.dev$/)
    expect(config.dashboardUrl).toMatch(/^https?:\/\//)
  })

  it('respects CVAULT_CONVEX_URL', () => {
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://override.convex.cloud')
    expect(resolveConfig().convexUrl).toBe('https://override.convex.cloud')
  })

  it('respects CVAULT_FRONTEND_API_URL', () => {
    vi.stubEnv('CVAULT_FRONTEND_API_URL', 'https://other.clerk.accounts.dev')
    expect(resolveConfig().frontendApiUrl).toBe('https://other.clerk.accounts.dev')
  })

  it('respects CVAULT_DASHBOARD_URL', () => {
    vi.stubEnv('CVAULT_DASHBOARD_URL', 'https://app.cvault.dev')
    expect(resolveConfig().dashboardUrl).toBe('https://app.cvault.dev')
  })
})
