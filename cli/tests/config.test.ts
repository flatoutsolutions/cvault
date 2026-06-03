/**
 * Spec: §7 + Task 13. CLI reads configuration from CVAULT_* env vars, then
 * compile-time `BUILD_DEFAULTS` baked in by the build orchestrator (so an
 * installed binary never gets hijacked by a foreign `.env.local` in the
 * user's CWD), then `~/.vault/config.json`, and finally the loose repo-dev
 * fallbacks (`VITE_CONVEX_URL` / `CLERK_FRONTEND_API_URL`) which Bun
 * auto-loads from `.env.local` in the working directory.
 *
 * Resolution order (highest priority first):
 *   1. CVAULT_* — always wins (explicit overrides)
 *   2. BUILD_DEFAULTS (compile-time, empty strings = none → fall through)
 *   3. ~/.vault/config.json
 *   4. VITE_CONVEX_URL / CLERK_FRONTEND_API_URL (repo-dev fallback only)
 *
 * Task 13 changes:
 *  - clientId is now required; resolved from CVAULT_OAUTH_CLIENT_ID → baked → file
 *  - dashboardUrl is now OPTIONAL (login no longer needs it)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveConfig } from '../src/config'

const REQUIRED_KEYS = [
  'CVAULT_CONVEX_URL',
  'CVAULT_FRONTEND_API_URL',
  'CVAULT_OAUTH_CLIENT_ID',
  'CVAULT_DASHBOARD_URL',
  'VITE_CONVEX_URL',
  'CLERK_FRONTEND_API_URL',
]

/** Minimum env for resolveConfig() to succeed without mocking the fs. */
function minEnv(): void {
  vi.stubEnv('CVAULT_CONVEX_URL', 'https://c.convex.cloud')
  vi.stubEnv('CVAULT_FRONTEND_API_URL', 'https://t.clerk.accounts.dev')
  vi.stubEnv('CVAULT_OAUTH_CLIENT_ID', 'client_test')
}

describe('resolveConfig', () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    for (const k of REQUIRED_KEYS) delete process.env[k]
  })

  afterEach(() => {
    process.env = { ...envBackup }
  })

  it('throws a helpful error when no config sources are set', async () => {
    vi.resetModules()
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        throw new Error('ENOENT')
      },
    }))
    const { resolveConfig: resolve } = await import('../src/config')
    expect(() => resolve()).toThrow(/missing required configuration/)
    vi.doUnmock('node:fs')
  })

  it('throws when clientId (CVAULT_OAUTH_CLIENT_ID) is missing', async () => {
    vi.resetModules()
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        throw new Error('ENOENT')
      },
    }))
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://c.convex.cloud')
    vi.stubEnv('CVAULT_FRONTEND_API_URL', 'https://t.clerk.accounts.dev')
    // CVAULT_OAUTH_CLIENT_ID intentionally not set
    const { resolveConfig: resolve } = await import('../src/config')
    expect(() => resolve()).toThrow(/missing required configuration/)
    vi.doUnmock('node:fs')
  })

  it('respects CVAULT_CONVEX_URL', () => {
    minEnv()
    expect(resolveConfig().convexUrl).toBe('https://c.convex.cloud')
  })

  it('respects CVAULT_FRONTEND_API_URL', () => {
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://c.convex.cloud')
    vi.stubEnv('CVAULT_FRONTEND_API_URL', 'https://other.clerk.accounts.dev')
    vi.stubEnv('CVAULT_OAUTH_CLIENT_ID', 'client_test')
    expect(resolveConfig().frontendApiUrl).toBe('https://other.clerk.accounts.dev')
  })

  it('respects CVAULT_OAUTH_CLIENT_ID', () => {
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://c.convex.cloud')
    vi.stubEnv('CVAULT_FRONTEND_API_URL', 'https://t.clerk.accounts.dev')
    vi.stubEnv('CVAULT_OAUTH_CLIENT_ID', 'client_from_env')
    expect(resolveConfig().clientId).toBe('client_from_env')
  })

  it('dashboardUrl is optional — resolveConfig succeeds without it', () => {
    minEnv()
    // No CVAULT_DASHBOARD_URL set — should not throw
    const c = resolveConfig()
    expect(c.convexUrl).toBe('https://c.convex.cloud')
    expect(c.dashboardUrl).toBeUndefined()
  })

  it('respects CVAULT_DASHBOARD_URL when provided', () => {
    minEnv()
    vi.stubEnv('CVAULT_DASHBOARD_URL', 'https://app.cvault.dev')
    expect(resolveConfig().dashboardUrl).toBe('https://app.cvault.dev')
  })

  it('falls back to repo .env.local naming (VITE_CONVEX_URL / CLERK_FRONTEND_API_URL)', () => {
    vi.stubEnv('VITE_CONVEX_URL', 'https://repo.convex.cloud')
    vi.stubEnv('CLERK_FRONTEND_API_URL', 'https://repo.clerk.accounts.dev')
    vi.stubEnv('CVAULT_OAUTH_CLIENT_ID', 'client_repo')
    const c = resolveConfig()
    expect(c.convexUrl).toBe('https://repo.convex.cloud')
    expect(c.frontendApiUrl).toBe('https://repo.clerk.accounts.dev')
    expect(c.clientId).toBe('client_repo')
  })

  it('CVAULT_* takes precedence over repo aliases', () => {
    vi.stubEnv('VITE_CONVEX_URL', 'https://repo.convex.cloud')
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://override.convex.cloud')
    vi.stubEnv('CVAULT_FRONTEND_API_URL', 'https://t.clerk.accounts.dev')
    vi.stubEnv('CVAULT_OAUTH_CLIENT_ID', 'client_test')
    expect(resolveConfig().convexUrl).toBe('https://override.convex.cloud')
  })
})

/**
 * BUILD_DEFAULTS tier — values baked into the compiled binary at build
 * time. Last-resort fallback after env vars and ~/.vault/config.json.
 */
describe('resolveConfig — BUILD_DEFAULTS tier', () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    for (const k of REQUIRED_KEYS) delete process.env[k]
  })

  afterEach(() => {
    process.env = { ...envBackup }
    vi.doUnmock('../src/buildInfo')
    vi.doUnmock('node:fs')
  })

  function mockMissingConfigFile(): void {
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        throw new Error('ENOENT')
      },
    }))
  }

  function mockConfigFile(content: Record<string, string>): void {
    vi.doMock('node:fs', () => ({
      readFileSync: () => JSON.stringify(content),
    }))
  }

  function mockBuildDefaults(defaults: {
    convexUrl: string
    frontendApiUrl: string
    clientId: string
    dashboardUrl: string
  }): void {
    vi.doMock('../src/buildInfo', () => ({ BUILD_DEFAULTS: defaults }))
  }

  it('uses BUILD_DEFAULTS when env and ~/.vault/config.json are empty', async () => {
    mockMissingConfigFile()
    mockBuildDefaults({
      convexUrl: 'https://baked.convex.cloud',
      frontendApiUrl: 'https://baked.clerk.accounts.dev',
      clientId: 'client_baked',
      dashboardUrl: 'https://baked.example.com',
    })
    const { resolveConfig: resolve } = await import('../src/config')
    const c = resolve()
    expect(c.convexUrl).toBe('https://baked.convex.cloud')
    expect(c.frontendApiUrl).toBe('https://baked.clerk.accounts.dev')
    expect(c.clientId).toBe('client_baked')
    expect(c.dashboardUrl).toBe('https://baked.example.com')
  })

  it('env vars take precedence over BUILD_DEFAULTS', async () => {
    mockMissingConfigFile()
    mockBuildDefaults({
      convexUrl: 'https://baked.convex.cloud',
      frontendApiUrl: 'https://baked.clerk.accounts.dev',
      clientId: 'client_baked',
      dashboardUrl: 'https://baked.example.com',
    })
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://envwins.convex.cloud')
    const { resolveConfig: resolve } = await import('../src/config')
    expect(resolve().convexUrl).toBe('https://envwins.convex.cloud')
    // Other two fall through to BUILD_DEFAULTS.
    expect(resolve().frontendApiUrl).toBe('https://baked.clerk.accounts.dev')
    expect(resolve().clientId).toBe('client_baked')
    expect(resolve().dashboardUrl).toBe('https://baked.example.com')
  })

  it('CVAULT_OAUTH_CLIENT_ID takes precedence over BUILD_DEFAULTS.clientId', async () => {
    mockMissingConfigFile()
    mockBuildDefaults({
      convexUrl: 'https://baked.convex.cloud',
      frontendApiUrl: 'https://baked.clerk.accounts.dev',
      clientId: 'client_baked',
      dashboardUrl: '',
    })
    vi.stubEnv('CVAULT_OAUTH_CLIENT_ID', 'client_from_env')
    const { resolveConfig: resolve } = await import('../src/config')
    expect(resolve().clientId).toBe('client_from_env')
  })

  it('~/.vault/config.json fills gaps when BUILD_DEFAULTS is empty for that key', async () => {
    mockConfigFile({
      convexUrl: 'https://filewins.convex.cloud',
      frontendApiUrl: 'https://filewins.clerk.accounts.dev',
      clientId: 'client_file',
      dashboardUrl: 'https://filewins.example.com',
    })
    mockBuildDefaults({
      convexUrl: '', // empty → file should fill
      frontendApiUrl: 'https://baked.clerk.accounts.dev',
      clientId: '', // empty → file should fill
      dashboardUrl: '', // empty → file should fill
    })
    const { resolveConfig: resolve } = await import('../src/config')
    // BUILD_DEFAULTS empty → file wins per-key.
    expect(resolve().convexUrl).toBe('https://filewins.convex.cloud')
    expect(resolve().clientId).toBe('client_file')
    // BUILD_DEFAULTS populated → still beats the file.
    expect(resolve().frontendApiUrl).toBe('https://baked.clerk.accounts.dev')
  })

  it('throws helpful error mentioning baked defaults when ALL sources empty', async () => {
    mockMissingConfigFile()
    mockBuildDefaults({ convexUrl: '', frontendApiUrl: '', clientId: '', dashboardUrl: '' })
    const { resolveConfig: resolve } = await import('../src/config')
    let caught: unknown
    try {
      resolve()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toMatch(/missing required configuration/)
    expect(msg).toMatch(/baked into the binary at build time/i)
  })

  it('BUILD_DEFAULTS beats VITE_CONVEX_URL when BUILD_DEFAULTS is populated', async () => {
    mockMissingConfigFile()
    mockBuildDefaults({
      convexUrl: 'https://baked.convex.cloud',
      frontendApiUrl: 'https://baked.clerk.accounts.dev',
      clientId: 'client_baked',
      dashboardUrl: 'https://baked.example.com',
    })
    vi.stubEnv('VITE_CONVEX_URL', 'https://hijacker.convex.cloud')
    const { resolveConfig: resolve } = await import('../src/config')
    expect(resolve().convexUrl).toBe('https://baked.convex.cloud')
  })

  it('BUILD_DEFAULTS beats CLERK_FRONTEND_API_URL when BUILD_DEFAULTS is populated', async () => {
    mockMissingConfigFile()
    mockBuildDefaults({
      convexUrl: 'https://baked.convex.cloud',
      frontendApiUrl: 'https://baked.clerk.accounts.dev',
      clientId: 'client_baked',
      dashboardUrl: 'https://baked.example.com',
    })
    vi.stubEnv('CLERK_FRONTEND_API_URL', 'https://hijacker.clerk.accounts.dev')
    const { resolveConfig: resolve } = await import('../src/config')
    expect(resolve().frontendApiUrl).toBe('https://baked.clerk.accounts.dev')
  })

  it('CVAULT_CONVEX_URL still beats BUILD_DEFAULTS (explicit override always wins)', async () => {
    mockMissingConfigFile()
    mockBuildDefaults({
      convexUrl: 'https://baked.convex.cloud',
      frontendApiUrl: 'https://baked.clerk.accounts.dev',
      clientId: 'client_baked',
      dashboardUrl: 'https://baked.example.com',
    })
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://override.convex.cloud')
    const { resolveConfig: resolve } = await import('../src/config')
    expect(resolve().convexUrl).toBe('https://override.convex.cloud')
  })

  it('~/.vault/config.json beats VITE/CLERK fallbacks but loses to BUILD_DEFAULTS', async () => {
    mockConfigFile({
      convexUrl: 'https://filewins.convex.cloud',
      // intentionally omit frontendApiUrl + dashboardUrl so we can exercise
      // the next tier (BUILD_DEFAULTS) for those.
    })
    mockBuildDefaults({
      convexUrl: 'https://baked.convex.cloud',
      frontendApiUrl: 'https://baked.clerk.accounts.dev',
      clientId: 'client_baked',
      dashboardUrl: 'https://baked.example.com',
    })
    vi.stubEnv('VITE_CONVEX_URL', 'https://loose.convex.cloud')
    vi.stubEnv('CLERK_FRONTEND_API_URL', 'https://loose.clerk.accounts.dev')
    const { resolveConfig: resolve } = await import('../src/config')
    const c = resolve()
    // BUILD_DEFAULTS wins for convexUrl over both file and loose env...
    expect(c.convexUrl).toBe('https://baked.convex.cloud')
    // ...and for the keys the file doesn't cover, BUILD_DEFAULTS still
    // wins over the loose env fallback.
    expect(c.frontendApiUrl).toBe('https://baked.clerk.accounts.dev')
    expect(c.dashboardUrl).toBe('https://baked.example.com')
  })

  it('~/.vault/config.json wins over loose VITE/CLERK env when BUILD_DEFAULTS is empty', async () => {
    mockConfigFile({
      convexUrl: 'https://filewins.convex.cloud',
      frontendApiUrl: 'https://filewins.clerk.accounts.dev',
      clientId: 'client_file',
      dashboardUrl: 'https://filewins.example.com',
    })
    mockBuildDefaults({ convexUrl: '', frontendApiUrl: '', clientId: '', dashboardUrl: '' })
    vi.stubEnv('VITE_CONVEX_URL', 'https://loose.convex.cloud')
    vi.stubEnv('CLERK_FRONTEND_API_URL', 'https://loose.clerk.accounts.dev')
    const { resolveConfig: resolve } = await import('../src/config')
    const c = resolve()
    expect(c.convexUrl).toBe('https://filewins.convex.cloud')
    expect(c.frontendApiUrl).toBe('https://filewins.clerk.accounts.dev')
    expect(c.clientId).toBe('client_file')
    expect(c.dashboardUrl).toBe('https://filewins.example.com')
  })
})
