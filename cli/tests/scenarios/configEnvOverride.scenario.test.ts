/**
 * Scenario — config priority chain (regression for the `cvault login` 404
 * "session expired" hijack).
 *
 * Background:
 *   `cvault login` reported `error: Clerk session expired or revoked.
 *   Re-run cvault login. (FAPI returned 404: No matching routes found)`
 *   for some users. The diagnosis: Bun auto-loads `.env.local` from the
 *   process CWD when the bundled CLI starts. Anyone running `cvault login`
 *   from a project directory whose `.env.local` defines
 *   `VITE_CONVEX_URL=<some-other-deployment>` ended up with the CLI hitting
 *   the wrong Convex deployment, which has no `/api/cli/mint-token` route.
 *
 *   Fix: change `cli/src/config.ts`'s priority so `BUILD_DEFAULTS` (baked
 *   into the installed binary) wins over the loose `VITE_*` / `CLERK_*`
 *   fallbacks. Explicit `CVAULT_*` env vars still beat both.
 *
 * What this scenario asserts (the END-TO-END resolution that the user
 * experiences when launching the binary):
 *   1. With BUILD_DEFAULTS populated AND `VITE_CONVEX_URL` in env,
 *      `resolveConfig().convexUrl` returns the BUILD_DEFAULTS value.
 *      (The original bug.)
 *   2. With BUILD_DEFAULTS empty AND `VITE_CONVEX_URL` in env, the loose
 *      env still works. (Repo-dev mode preservation.)
 *   3. `CVAULT_CONVEX_URL` always wins regardless of the other two.
 *
 * The test exercises the same `resolveConfig()` function the production
 * binary calls — there is no mock layer between it and reality except for
 * `node:fs.readFileSync` (so the developer's actual `~/.vault/config.json`
 * doesn't bleed into the assertion) and `buildInfo` (to simulate the
 * bake-time substitution that `scripts/build.ts` performs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const REQUIRED_ENV_KEYS = [
  'CVAULT_CONVEX_URL',
  'CVAULT_FRONTEND_API_URL',
  'CVAULT_DASHBOARD_URL',
  'VITE_CONVEX_URL',
  'CLERK_FRONTEND_API_URL',
] as const

beforeEach(() => {
  vi.resetModules()
  for (const k of REQUIRED_ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  vi.doUnmock('../../src/buildInfo')
  vi.doUnmock('node:fs')
})

function mockMissingConfigFile(): void {
  vi.doMock('node:fs', () => ({
    readFileSync: () => {
      throw new Error('ENOENT')
    },
  }))
}

function mockBuildDefaults(defaults: { convexUrl: string; frontendApiUrl: string; dashboardUrl: string }): void {
  vi.doMock('../../src/buildInfo', () => ({ BUILD_DEFAULTS: defaults }))
}

describe('Scenario — config priority chain (foreign .env.local hijack regression)', () => {
  it('installed binary: BUILD_DEFAULTS beats VITE_CONVEX_URL even when set in process env', async () => {
    // Simulate the exact production failure mode: Bun has auto-loaded
    // `.env.local` from the user's CWD and dropped `VITE_CONVEX_URL`
    // pointing at a foreign deployment. The compiled binary should
    // ignore that and use its own baked URL.
    mockMissingConfigFile()
    mockBuildDefaults({
      convexUrl: 'https://prod-cvault.convex.cloud',
      frontendApiUrl: 'https://prod.clerk.accounts.dev',
      dashboardUrl: 'https://app.cvault.dev',
    })
    vi.stubEnv('VITE_CONVEX_URL', 'https://foreign-project.convex.cloud')
    vi.stubEnv('CLERK_FRONTEND_API_URL', 'https://foreign.clerk.accounts.dev')

    const { resolveConfig } = await import('../../src/config')
    const c = resolveConfig()
    expect(c.convexUrl).toBe('https://prod-cvault.convex.cloud')
    expect(c.frontendApiUrl).toBe('https://prod.clerk.accounts.dev')
    expect(c.dashboardUrl).toBe('https://app.cvault.dev')
  })

  it('repo-dev mode (BUILD_DEFAULTS empty): VITE_CONVEX_URL fallback still works', async () => {
    // The clean working copy ships `BUILD_DEFAULTS` as three empty strings.
    // In repo-dev mode (`bun cli/src/index.ts ...`), `pickString` falls
    // through past BUILD_DEFAULTS to the loose env, so iterative
    // development against a personal deployment still works.
    mockMissingConfigFile()
    mockBuildDefaults({ convexUrl: '', frontendApiUrl: '', dashboardUrl: '' })
    vi.stubEnv('VITE_CONVEX_URL', 'https://devloop.convex.cloud')
    vi.stubEnv('CLERK_FRONTEND_API_URL', 'https://devloop.clerk.accounts.dev')
    vi.stubEnv('CVAULT_DASHBOARD_URL', 'http://localhost:3000')

    const { resolveConfig } = await import('../../src/config')
    const c = resolveConfig()
    expect(c.convexUrl).toBe('https://devloop.convex.cloud')
    expect(c.frontendApiUrl).toBe('https://devloop.clerk.accounts.dev')
    expect(c.dashboardUrl).toBe('http://localhost:3000')
  })

  it('CVAULT_CONVEX_URL beats BUILD_DEFAULTS (explicit override always wins)', async () => {
    // The user's escape hatch: any explicit `CVAULT_*` env var is the
    // single tier 1 source. Used by power users running against a
    // staging deployment without rebuilding the binary.
    mockMissingConfigFile()
    mockBuildDefaults({
      convexUrl: 'https://baked.convex.cloud',
      frontendApiUrl: 'https://baked.clerk.accounts.dev',
      dashboardUrl: 'https://baked.example.com',
    })
    vi.stubEnv('CVAULT_CONVEX_URL', 'https://override.convex.cloud')
    vi.stubEnv('VITE_CONVEX_URL', 'https://hijacker.convex.cloud')

    const { resolveConfig } = await import('../../src/config')
    expect(resolveConfig().convexUrl).toBe('https://override.convex.cloud')
  })
})
