/**
 * Resolve runtime configuration for the CLI.
 *
 * Resolution order (highest priority first):
 *   1. Explicit `CVAULT_*` env vars — power-user overrides; always win.
 *   2. `BUILD_DEFAULTS` from `buildInfo.ts` — values baked into the
 *      compiled binary by `scripts/build.ts` at release time. On a
 *      clean working copy these are three empty strings (dev mode),
 *      which `pickString` filters out so resolution falls through to
 *      tier 3+.
 *   3. `~/.vault/config.json` — gap-filler for keys that
 *      `BUILD_DEFAULTS` leaves empty (e.g., a developer-built binary
 *      missing one of the three URLs). Plain JSON: `{convexUrl,
 *      frontendApiUrl, dashboardUrl}`. Optional file; missing keys
 *      fall through. Full overrides require the `CVAULT_*` env vars
 *      in tier 1 — the file no longer beats `BUILD_DEFAULTS`,
 *      intentionally, so a stale `config.json` on a Homebrew user's
 *      machine cannot override the binary's baked-in URLs and silently
 *      re-point the CLI at a wrong deployment.
 *   4. Project-root `.env*` fallbacks (auto-loaded by Bun from CWD):
 *        VITE_CONVEX_URL          → convexUrl
 *        CLERK_FRONTEND_API_URL   → frontendApiUrl
 *      Repo-dev mode only — these are intended for `bun cli/src/index.ts`
 *      against a personal deployment when BUILD_DEFAULTS is empty.
 *
 * Why BUILD_DEFAULTS beats the loose `VITE_*` / `CLERK_*` fallbacks:
 *   Bun auto-loads `.env.local` from the process CWD when the bundled
 *   binary starts. Under the original priority (`VITE_CONVEX_URL` >
 *   `BUILD_DEFAULTS`), a user running `cvault login` from a project
 *   directory whose `.env.local` defines `VITE_CONVEX_URL=<other>` had
 *   their CLI silently re-pointed at the wrong Convex deployment, which
 *   has no `/api/cli/mint-token` route. The 404 surfaced as the
 *   misleading "Clerk session expired" prompt. Putting BUILD_DEFAULTS
 *   ahead of the loose env makes installed binaries deterministic
 *   regardless of CWD; the explicit `CVAULT_*` escape hatch is still
 *   tier 1.
 *
 * Missing required fields → throw a clear error so the user knows
 * exactly which value to set.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7 + §13.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BUILD_DEFAULTS } from './buildInfo'

export interface RuntimeConfig {
  /** Convex deployment base URL. */
  convexUrl: string
  /** Clerk Frontend API base URL — used for ticket exchange + JWT mints. */
  frontendApiUrl: string
  /** Dashboard base URL — `cvault login` opens `${dashboardUrl}/cli/link`. */
  dashboardUrl: string
}

interface PartialConfigFile {
  convexUrl?: unknown
  frontendApiUrl?: unknown
  dashboardUrl?: unknown
}

const CONFIG_PATH = join(homedir(), '.vault', 'config.json')

function readConfigFile(): PartialConfigFile {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw) as PartialConfigFile
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function pickString(...candidates: Array<unknown>): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return undefined
}

export function resolveConfig(): RuntimeConfig {
  const file = readConfigFile()

  // Tier order: CVAULT_* (explicit) → BUILD_DEFAULTS (baked into installed
  // binary) → file → loose VITE_/CLERK_ fallback (repo-dev only). See the
  // top-of-file docstring for the rationale (foreign `.env.local` hijack).
  const convexUrl = pickString(
    process.env.CVAULT_CONVEX_URL,
    BUILD_DEFAULTS.convexUrl,
    file.convexUrl,
    process.env.VITE_CONVEX_URL
  )
  const frontendApiUrl = pickString(
    process.env.CVAULT_FRONTEND_API_URL,
    BUILD_DEFAULTS.frontendApiUrl,
    file.frontendApiUrl,
    process.env.CLERK_FRONTEND_API_URL
  )
  // dashboardUrl has no loose-env analog (no `VITE_*` equivalent), so
  // the chain is just: explicit → baked → file.
  const dashboardUrl = pickString(process.env.CVAULT_DASHBOARD_URL, BUILD_DEFAULTS.dashboardUrl, file.dashboardUrl)

  const missing: string[] = []
  if (!convexUrl) missing.push('CVAULT_CONVEX_URL (or VITE_CONVEX_URL in repo .env.local)')
  if (!frontendApiUrl) missing.push('CVAULT_FRONTEND_API_URL (or CLERK_FRONTEND_API_URL in repo .env.local)')
  if (!dashboardUrl) missing.push('CVAULT_DASHBOARD_URL')

  if (!convexUrl || !frontendApiUrl || !dashboardUrl) {
    throw new Error(
      `cvault is missing required configuration. Set the following:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        `\n\nOptions:\n` +
        `  - Export as shell env vars (recommended for installed binary)\n` +
        `  - Create ${CONFIG_PATH} with JSON: ` +
        `{ "convexUrl": "...", "frontendApiUrl": "...", "dashboardUrl": "..." }\n` +
        `  - Run from the cvault repo root where Bun auto-loads .env.local\n` +
        `  - Build a binary with values baked into the binary at build time ` +
        `(set CVAULT_*_URL or VITE/CLERK fallback env vars before running ` +
        `\`bun run scripts/build.ts <target>\`)`
    )
  }

  return { convexUrl, frontendApiUrl, dashboardUrl }
}
