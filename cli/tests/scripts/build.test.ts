/**
 * Tests for the build orchestrator helpers (cli/scripts/build.ts).
 *
 * The orchestrator's job is to:
 *   1. Read CVAULT_*_URL / CVAULT_OAUTH_CLIENT_ID or VITE/CLERK fallback env vars
 *   2. Write those values into src/buildInfo.ts so `bun build --compile`
 *      bakes them into the binary
 *   3. Run `bun build` for the requested target
 *   4. ALWAYS reset buildInfo.ts to empty defaults afterward so dev runs
 *      don't pick up baked values from a previous build
 *
 * These tests cover the pure helpers — file rewriting + env resolution —
 * not the spawn-bun-build orchestration itself (that requires an actual
 * Bun toolchain and is verified by the build:* package.json scripts).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EMPTY_BUILD_DEFAULTS, resolveBuildDefaultsFromEnv, writeBuildInfo } from '../../scripts/build'

describe('writeBuildInfo', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cvault-buildinfo-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('writes a TypeScript module exporting BUILD_DEFAULTS with the given values', () => {
    const target = join(tmp, 'buildInfo.ts')
    writeBuildInfo(target, {
      convexUrl: 'https://x.convex.cloud',
      frontendApiUrl: 'https://x.clerk.accounts.dev',
      clientId: 'client_baked',
      dashboardUrl: 'https://x.example.com',
    })
    const content = readFileSync(target, 'utf8')
    expect(content).toContain("convexUrl: 'https://x.convex.cloud'")
    expect(content).toContain("frontendApiUrl: 'https://x.clerk.accounts.dev'")
    expect(content).toContain("clientId: 'client_baked'")
    expect(content).toContain("dashboardUrl: 'https://x.example.com'")
    expect(content).toContain('export const BUILD_DEFAULTS')
  })

  it('writes EMPTY_BUILD_DEFAULTS as four empty strings (the dev-reset shape)', () => {
    const target = join(tmp, 'buildInfo.ts')
    writeBuildInfo(target, EMPTY_BUILD_DEFAULTS)
    const content = readFileSync(target, 'utf8')
    expect(content).toContain("convexUrl: ''")
    expect(content).toContain("frontendApiUrl: ''")
    expect(content).toContain("clientId: ''")
    expect(content).toContain("dashboardUrl: ''")
  })
})

describe('resolveBuildDefaultsFromEnv', () => {
  const KEYS = [
    'CVAULT_CONVEX_URL',
    'CVAULT_FRONTEND_API_URL',
    'CVAULT_OAUTH_CLIENT_ID',
    'CVAULT_DASHBOARD_URL',
    'VITE_CONVEX_URL',
    'CLERK_FRONTEND_API_URL',
  ]
  const backup = { ...process.env }

  beforeEach(() => {
    for (const k of KEYS) delete process.env[k]
  })

  afterEach(() => {
    process.env = { ...backup }
  })

  it('reads CVAULT_* directly when set', () => {
    process.env.CVAULT_CONVEX_URL = 'https://c.convex.cloud'
    process.env.CVAULT_FRONTEND_API_URL = 'https://c.clerk.accounts.dev'
    process.env.CVAULT_OAUTH_CLIENT_ID = 'client_baked'
    process.env.CVAULT_DASHBOARD_URL = 'https://c.example.com'
    expect(resolveBuildDefaultsFromEnv(process.env)).toEqual({
      convexUrl: 'https://c.convex.cloud',
      frontendApiUrl: 'https://c.clerk.accounts.dev',
      clientId: 'client_baked',
      dashboardUrl: 'https://c.example.com',
    })
  })

  it('falls back to VITE_CONVEX_URL / CLERK_FRONTEND_API_URL (repo .env.local naming)', () => {
    process.env.VITE_CONVEX_URL = 'https://repo.convex.cloud'
    process.env.CLERK_FRONTEND_API_URL = 'https://repo.clerk.accounts.dev'
    process.env.CVAULT_OAUTH_CLIENT_ID = 'client_repo'
    process.env.CVAULT_DASHBOARD_URL = 'http://localhost:3000'
    expect(resolveBuildDefaultsFromEnv(process.env)).toEqual({
      convexUrl: 'https://repo.convex.cloud',
      frontendApiUrl: 'https://repo.clerk.accounts.dev',
      clientId: 'client_repo',
      dashboardUrl: 'http://localhost:3000',
    })
  })

  it('returns empty strings for any value not present in env', () => {
    expect(resolveBuildDefaultsFromEnv({})).toEqual(EMPTY_BUILD_DEFAULTS)
  })

  it('clientId comes from CVAULT_OAUTH_CLIENT_ID with no fallback alias', () => {
    process.env.CVAULT_CONVEX_URL = 'https://c.convex.cloud'
    process.env.CVAULT_FRONTEND_API_URL = 'https://c.clerk.accounts.dev'
    process.env.CVAULT_OAUTH_CLIENT_ID = 'client_explicit'
    const result = resolveBuildDefaultsFromEnv(process.env)
    expect(result.clientId).toBe('client_explicit')
  })
})
