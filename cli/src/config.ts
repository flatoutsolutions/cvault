/**
 * Resolve runtime configuration for the CLI.
 *
 * Resolution order (highest priority first):
 *   1. Explicit `CVAULT_*` env vars
 *   2. Project-root `.env*` fallbacks (auto-loaded by Bun from cwd):
 *        VITE_CONVEX_URL          → convexUrl
 *        CLERK_FRONTEND_API_URL   → frontendApiUrl
 *        CVAULT_DASHBOARD_URL     → dashboardUrl  (no project-root analog)
 *   3. `~/.vault/config.json` — for users who installed via Homebrew and
 *      don't run from the repo. Plain JSON: `{convexUrl, frontendApiUrl,
 *      dashboardUrl}`. Optional file; missing keys fall through.
 *
 * No bundled defaults. Missing required fields → throw a clear error so
 * the user knows exactly which value to set.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7 + §13.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

  const convexUrl = pickString(process.env.CVAULT_CONVEX_URL, process.env.VITE_CONVEX_URL, file.convexUrl)
  const frontendApiUrl = pickString(
    process.env.CVAULT_FRONTEND_API_URL,
    process.env.CLERK_FRONTEND_API_URL,
    file.frontendApiUrl
  )
  const dashboardUrl = pickString(process.env.CVAULT_DASHBOARD_URL, file.dashboardUrl)

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
        `  - Run from the cvault repo root where Bun auto-loads .env.local`
    )
  }

  return { convexUrl, frontendApiUrl, dashboardUrl }
}
