/**
 * Resolve runtime configuration for the CLI.
 *
 * Priority (highest first):
 *   1. Environment variables (`CVAULT_CONVEX_URL`, etc.)
 *   2. Bundled defaults (the prod deployment + dashboard URLs)
 *
 * Env var overrides exist primarily for dev — pointing the CLI at a
 * local Convex dev deployment + a localhost dashboard.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7 + §13.
 */

export interface RuntimeConfig {
  /** Convex deployment base URL. */
  convexUrl: string
  /** Clerk Frontend API base URL — used for ticket exchange + JWT mints. */
  frontendApiUrl: string
  /** Dashboard base URL — `cvault login` opens `${dashboardUrl}/cli/link`. */
  dashboardUrl: string
}

// Default constants — bundled at build time. Override via env for dev.
// These mirror the values currently in /Users/saadings/Desktop/cvault/.env.local
// for the dev deployment. Production values will be swapped in via CI when we
// flip a `cvault prod` build profile.
const DEFAULT_CONVEX_URL = 'https://beloved-mouse-707.convex.cloud'
const DEFAULT_FRONTEND_API_URL = 'https://intent-mollusk-81.clerk.accounts.dev'
// Local dev default. Override with CVAULT_DASHBOARD_URL when prod domain exists.
const DEFAULT_DASHBOARD_URL = 'http://localhost:3000'

export function resolveConfig(): RuntimeConfig {
  return {
    convexUrl: process.env.CVAULT_CONVEX_URL ?? DEFAULT_CONVEX_URL,
    frontendApiUrl: process.env.CVAULT_FRONTEND_API_URL ?? DEFAULT_FRONTEND_API_URL,
    dashboardUrl: process.env.CVAULT_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL,
  }
}
