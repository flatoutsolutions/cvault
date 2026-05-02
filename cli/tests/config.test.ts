/**
 * Spec: §7. CLI reads configuration from CVAULT_* env vars, fallback to
 * VITE_CONVEX_URL / CLERK_FRONTEND_API_URL (repo .env.local), then to
 * ~/.vault/config.json, then to compile-time `BUILD_DEFAULTS` baked in by
 * the build orchestrator.
 *
 * Resolution order (highest priority first):
 *   1. CVAULT_*
 *   2. VITE_CONVEX_URL / CLERK_FRONTEND_API_URL
 *   3. ~/.vault/config.json
 *   4. BUILD_DEFAULTS (compile-time, empty strings = none)
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

  it('throws a helpful error when no config sources are set', async () => {
    // Mock readFileSync so this test isn't dependent on whether the
    // developer happens to have a populated ~/.vault/config.json on
    // the host machine. (BUILD_DEFAULTS is empty in dev sources, so
    // we don't need to mock that — the placeholder file already
    // exports three empty strings, which `pickString` filters out.)
    //
    // resetModules + doMock + dynamic import ensures we get a fresh
    // evaluation of config.ts with the mocked fs in place. The static
    // top-of-file `import { resolveConfig }` is bound to the original
    // (real-fs) evaluation and would silently use the actual config
    // file otherwise.
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

/**
 * BUILD_DEFAULTS tier — values baked into the compiled binary at build
 * time. Last-resort fallback after env vars and ~/.vault/config.json.
 *
 * These tests use `vi.doMock` to substitute different `BUILD_DEFAULTS`
 * values per test case, plus mocks the `node:fs.readFileSync` call that
 * reads `~/.vault/config.json` so the developer's actual config file
 * doesn't interfere with the test outcome.
 */
describe('resolveConfig — BUILD_DEFAULTS tier', () => {
  const envBackup = { ...process.env }

  beforeEach(() => {
    // Reset modules so each test gets a fresh evaluation of config.ts
    // that picks up the per-test `vi.doMock(...)` for buildInfo and
    // node:fs (without resetModules the cached bindings are reused).
    vi.resetModules()
    for (const k of REQUIRED_KEYS) delete process.env[k]
  })

  afterEach(() => {
    process.env = { ...envBackup }
    vi.doUnmock('../src/buildInfo')
    vi.doUnmock('node:fs')
  })

  function mockMissingConfigFile(): void {
    // readConfigFile() catches all errors and returns {}, so making
    // readFileSync throw "file not found" cleanly simulates the
    // "no ~/.vault/config.json" case.
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

  function mockBuildDefaults(defaults: { convexUrl: string; frontendApiUrl: string; dashboardUrl: string }): void {
    vi.doMock('../src/buildInfo', () => ({ BUILD_DEFAULTS: defaults }))
  }

  it('uses BUILD_DEFAULTS when env and ~/.vault/config.json are empty', async () => {
    mockMissingConfigFile()
    mockBuildDefaults({
      convexUrl: 'https://baked.convex.cloud',
      frontendApiUrl: 'https://baked.clerk.accounts.dev',
      dashboardUrl: 'https://baked.example.com',
    })
    const { resolveConfig: resolve } = await import('../src/config')
    const c = resolve()
    expect(c.convexUrl).toBe('https://baked.convex.cloud')
    expect(c.frontendApiUrl).toBe('https://baked.clerk.accounts.dev')
    expect(c.dashboardUrl).toBe('https://baked.example.com')
  })

  it('env vars take precedence over BUILD_DEFAULTS', async () => {
    mockMissingConfigFile()
    mockBuildDefaults({
      convexUrl: 'https://baked.convex.cloud',
      frontendApiUrl: 'https://baked.clerk.accounts.dev',
      dashboardUrl: 'https://baked.example.com',
    })
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://envwins.convex.cloud')
    const { resolveConfig: resolve } = await import('../src/config')
    expect(resolve().convexUrl).toBe('https://envwins.convex.cloud')
    // Other two fall through to BUILD_DEFAULTS.
    expect(resolve().frontendApiUrl).toBe('https://baked.clerk.accounts.dev')
    expect(resolve().dashboardUrl).toBe('https://baked.example.com')
  })

  it('~/.vault/config.json takes precedence over BUILD_DEFAULTS', async () => {
    mockConfigFile({
      convexUrl: 'https://filewins.convex.cloud',
      frontendApiUrl: 'https://filewins.clerk.accounts.dev',
      dashboardUrl: 'https://filewins.example.com',
    })
    mockBuildDefaults({
      convexUrl: 'https://baked.convex.cloud',
      frontendApiUrl: 'https://baked.clerk.accounts.dev',
      dashboardUrl: 'https://baked.example.com',
    })
    const { resolveConfig: resolve } = await import('../src/config')
    expect(resolve().convexUrl).toBe('https://filewins.convex.cloud')
    expect(resolve().frontendApiUrl).toBe('https://filewins.clerk.accounts.dev')
    expect(resolve().dashboardUrl).toBe('https://filewins.example.com')
  })

  it('throws helpful error mentioning baked defaults when ALL sources empty', async () => {
    mockMissingConfigFile()
    mockBuildDefaults({ convexUrl: '', frontendApiUrl: '', dashboardUrl: '' })
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
    // Error message lists the four ways to set config; the fourth option
    // mentions the build-time defaults so users know what's available.
    expect(msg).toMatch(/baked into the binary at build time/i)
  })
})
