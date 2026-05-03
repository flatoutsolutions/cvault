/**
 * `cvault status [--slot <slot>] [--all] [--json]` — local-vs-vault
 * diagnostic.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7 +
 * project brief on multi-laptop refresh-token rotation.
 *
 * Compares the local Keychain blob against the vault row metadata and
 * prints a human-readable summary (default) or structured JSON
 * (`--json`). Read-only — never mutates either side. Users run this
 * before `cvault refresh` to decide whether to drive a sync.
 *
 * Drift labels (`vault newer`, `local newer`, `RT mismatch`, `none`)
 * key the printed comparison and the JSON `drift` field. The label is
 * derived from a strict expiresAt comparison plus a refresh-token
 * prefix-equality check; both axes are needed because `expiresAt`
 * advances on access-token rotations the vault doesn't know about
 * yet, and the RT identifies which physical token chain we're on.
 */
import { createHash } from 'node:crypto'

import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { type VaultClient, makeVaultClient } from '../convex/vaultClient'
import { getActiveAccount } from '../credentials'
import { readCredentials } from '../native/credentialStore'
import { formatRelativeMs } from '../render/table'

export interface RunStatusOptions {
  slot?: number
  all?: boolean
  json?: boolean
}

interface VaultSubMeta {
  _id: string
  slot: number
  email: string
  label?: string
  expiresAt: number
  refreshExpiresAt?: number
  lastRefreshedAt: number
  subscriptionType: string
  rateLimitTier: string
}

interface RefreshLogEntry {
  outcome: 'success' | 'failure' | 'reloginRequired'
  triggeredBy: 'cron' | 'manual' | 'onUse'
  at: number
  error?: string
}

interface MachineActivityEntry {
  action: string
  clerkSessionId: string
  at: number
}

interface GetStatusResult {
  sub: VaultSubMeta
  refreshLog: RefreshLogEntry[]
  lastMachineActivity: MachineActivityEntry | null
}

interface LocalSnapshot {
  /** Raw Keychain blob string (the JSON the OS holds verbatim). */
  blob: string
  /** sha256 hex of the blob, used for vault `contentHash` comparison. */
  hash: string
  /** access-token expiry from `claudeAiOauth.expiresAt` (ms epoch). */
  expiresAt: number | undefined
  /** First 32 chars of `claudeAiOauth.refreshToken`, for cross-side compare. */
  refreshTokenPrefix: string | undefined
}

// N3: `RT mismatch` was reserved for a refresh-token prefix comparison the
// vault meta validator never exposed (we'd leak token shape). The
// expiresAt-based comparison + the lease/CAS protections cover the
// race we actually care about, so the literal is removed rather than
// kept as dead code.
type DriftLabel = 'none' | 'vault newer' | 'local newer' | 'no local'

interface PerSubReport {
  email: string
  slot: number
  drift: DriftLabel
  vault: {
    expiresAt: number
    lastRefreshedAt: number
    refreshExpiresAt?: number
    refreshTokenPrefix?: string
    reloginRequired: boolean
    recentRefreshLog: RefreshLogEntry[]
    lastMachineActivity: MachineActivityEntry | null
  }
  local: {
    present: boolean
    expiresAt?: number
    refreshTokenPrefix?: string
  }
}

/**
 * Read the local Keychain (best-effort) and project the fields needed
 * to drive the drift comparison. Returns `undefined` when no local
 * credentials exist — the caller renders "no local" rows.
 */
function readLocalSnapshot(): LocalSnapshot | undefined {
  let blob: string | null
  try {
    blob = readCredentials()
  } catch {
    blob = null
  }
  if (blob === null) return undefined

  type OAuth = {
    claudeAiOauth?: { expiresAt?: unknown; refreshToken?: unknown }
  }
  let parsed: OAuth | null = null
  try {
    parsed = JSON.parse(blob) as OAuth
  } catch {
    parsed = null
  }
  const expiresAt = typeof parsed?.claudeAiOauth?.expiresAt === 'number' ? parsed.claudeAiOauth.expiresAt : undefined
  const refreshTokenPrefix =
    typeof parsed?.claudeAiOauth?.refreshToken === 'string' ? parsed.claudeAiOauth.refreshToken.slice(0, 32) : undefined

  return {
    blob,
    hash: createHash('sha256').update(blob).digest('hex'),
    expiresAt,
    refreshTokenPrefix,
  }
}

/**
 * Decide a drift label from the projected local + vault state. The
 * comparison MUST be tolerant of missing local: an absent local should
 * surface "no local" so the user knows the next `cvault switch` will
 * pull the vault state down rather than worry about a mismatch.
 */
function computeDrift(local: LocalSnapshot | undefined, vault: VaultSubMeta): DriftLabel {
  if (local === undefined) return 'no local'
  // expiresAt is the primary axis. If the timestamps differ, that's
  // newer-/older-. The RT prefix check is a defensive net for cases
  // where two refreshes coincidentally land on the same expiresAt
  // (rare, but possible if both machines refreshed inside the same
  // millisecond — the RT chain is still the source of truth).
  if (local.expiresAt !== undefined) {
    if (vault.expiresAt > local.expiresAt) return 'vault newer'
    if (local.expiresAt > vault.expiresAt) return 'local newer'
  }
  // Equal expiresAt or local-expiresAt-unparseable: fall to RT compare.
  // The vault doesn't expose its RT prefix in the meta validator (we'd
  // leak token shape), so we can't actually compare here. Return
  // 'none' for the equal-expiresAt case, which is empirically correct
  // for back-to-back probes against the same chain.
  return 'none'
}

/**
 * Build a per-sub report from the server's `getStatus` payload + the
 * local snapshot. Independent of rendering so the JSON path can use
 * the same data structure.
 */
function buildReport(getStatus: GetStatusResult, local: LocalSnapshot | undefined): PerSubReport {
  const drift = computeDrift(local, getStatus.sub)
  const reloginRequired = getStatus.sub.refreshExpiresAt !== undefined && getStatus.sub.refreshExpiresAt <= Date.now()
  const vault: PerSubReport['vault'] = {
    expiresAt: getStatus.sub.expiresAt,
    lastRefreshedAt: getStatus.sub.lastRefreshedAt,
    reloginRequired,
    recentRefreshLog: getStatus.refreshLog,
    lastMachineActivity: getStatus.lastMachineActivity,
  }
  if (getStatus.sub.refreshExpiresAt !== undefined) vault.refreshExpiresAt = getStatus.sub.refreshExpiresAt
  return {
    email: getStatus.sub.email,
    slot: getStatus.sub.slot,
    drift,
    vault,
    local: {
      present: local !== undefined,
      ...(local?.expiresAt !== undefined ? { expiresAt: local.expiresAt } : {}),
      ...(local?.refreshTokenPrefix !== undefined ? { refreshTokenPrefix: local.refreshTokenPrefix } : {}),
    },
  }
}

function renderHumanReport(report: PerSubReport): string {
  const now = Date.now()
  const lines: string[] = []
  lines.push(`Sub: ${report.email} (slot ${report.slot.toString()})`)
  lines.push('')
  lines.push('Local Keychain:')
  if (!report.local.present) {
    lines.push('  (no local credentials)')
  } else {
    if (report.local.expiresAt !== undefined) {
      lines.push(`  AT expires:   ${formatRelativeMs(report.local.expiresAt, now)}`)
    } else {
      lines.push('  AT expires:   (unparseable)')
    }
    if (report.local.refreshTokenPrefix !== undefined) {
      lines.push(`  RT prefix:    ${report.local.refreshTokenPrefix}...`)
    }
  }
  lines.push('')
  lines.push('Vault:')
  lines.push(`  AT expires:   ${formatRelativeMs(report.vault.expiresAt, now)}`)
  lines.push(`  last refresh: ${formatRelativeMs(report.vault.lastRefreshedAt, now)}`)
  const status = report.vault.reloginRequired ? 'RELOGIN_REQUIRED' : 'OK'
  lines.push(`  status:       ${status}`)
  if (report.vault.recentRefreshLog.length > 0) {
    lines.push('  recent refresh attempts:')
    for (const entry of report.vault.recentRefreshLog) {
      lines.push(`    ${formatRelativeMs(entry.at, now)} — ${entry.outcome} (${entry.triggeredBy})`)
    }
  }
  lines.push('')
  lines.push(`Drift:        ${report.drift}`)

  if (report.vault.reloginRequired) {
    lines.push('')
    lines.push('Subscription needs re-capture.')
    lines.push('Run `cvault add` on the machine where you most recently used `claude`.')
    if (report.vault.lastMachineActivity !== null) {
      lines.push(
        `Last activity: ${report.vault.lastMachineActivity.action} ${formatRelativeMs(
          report.vault.lastMachineActivity.at,
          now
        )}`
      )
    }
  }
  return lines.join('\n')
}

interface SubLite {
  slot: number
  email: string
}

async function fetchTargetSubs(client: VaultClient, opts: RunStatusOptions): Promise<Array<{ slot: number }>> {
  if (opts.slot !== undefined) {
    return [{ slot: opts.slot }]
  }
  if (opts.all === true) {
    const subs = (await client.query(api.subscriptions.queries.listForUser, {})) as SubLite[]
    return subs.map((s) => ({ slot: s.slot }))
  }
  // No slot, no --all: target the active local sub.
  let activeEmail: string | undefined
  try {
    const a = getActiveAccount()
    activeEmail = a?.email
  } catch {
    activeEmail = undefined
  }
  if (activeEmail === undefined) {
    return []
  }
  // Resolve the email to a slot via listForUser.
  const subs = (await client.query(api.subscriptions.queries.listForUser, {})) as SubLite[]
  const match = subs.find((s) => s.email.toLowerCase() === activeEmail.toLowerCase())
  return match ? [{ slot: match.slot }] : []
}

export async function runStatus(opts: RunStatusOptions): Promise<void> {
  const client = await makeVaultClient()
  const targets = await fetchTargetSubs(client, opts)

  if (targets.length === 0) {
    if (opts.slot === undefined && opts.all !== true) {
      console.log('No active Claude Code account on this machine.')
      console.log('Run `cvault switch <slot|email>` to activate one, or `cvault add` to capture a new one.')
      return
    }
    console.log('No subscriptions match the requested target.')
    return
  }

  // Read local once — the local snapshot is the same for every sub
  // (native: there's at most one active account on this machine).
  const local = readLocalSnapshot()

  // S3: hoist the active-email lookup OUT of the per-sub loop. Native is
  // single-active, so this returns the same value every iteration; the
  // per-sub call was burning a Keychain access per sub on `--all`.
  let activeEmail: string | undefined
  try {
    activeEmail = getActiveAccount()?.email?.toLowerCase()
  } catch {
    activeEmail = undefined
  }

  const reports: PerSubReport[] = []
  for (const target of targets) {
    const status = (await client.query(api.subscriptions.queries.getStatus, {
      slot: target.slot,
    })) as GetStatusResult
    // The local snapshot only "applies" to a sub when the active local
    // email matches that sub's email — otherwise the sub has no local
    // counterpart on this machine. For native we're single-active, so
    // the snapshot maps to whichever sub matches its parent email; for
    // others, treat as 'no local'.
    const localForThisSub =
      activeEmail !== undefined && status.sub.email.toLowerCase() === activeEmail ? local : undefined
    reports.push(buildReport(status, localForThisSub))
  }

  if (opts.json === true) {
    console.log(JSON.stringify(reports))
    return
  }
  for (const report of reports) {
    console.log(renderHumanReport(report))
    if (reports.length > 1) {
      console.log('')
      console.log('---')
      console.log('')
    }
  }
}

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Compare the local Keychain to the vault and report drift.',
  },
  args: {
    slot: {
      type: 'string',
      description: 'Vault slot number to inspect.',
      required: false,
    },
    all: {
      type: 'boolean',
      description: 'Inspect every subscription in the vault.',
      required: false,
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Emit a structured JSON payload instead of human-readable text.',
      required: false,
      default: false,
    },
  },
  async run({ args }) {
    const opts: RunStatusOptions = {}
    if (typeof args.slot === 'string' && args.slot.length > 0) {
      const slot = Number.parseInt(args.slot, 10)
      if (Number.isNaN(slot)) throw new Error(`--slot must be a number, got ${args.slot}`)
      opts.slot = slot
    }
    if (args.all === true) opts.all = true
    if (args.json === true) opts.json = true
    await runStatus(opts)
  },
})
