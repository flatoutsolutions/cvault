/**
 * `cvault refresh [--slot <slot>] [--force]` — multi-laptop OAuth
 * refresh coordinator.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7 +
 * project brief on multi-laptop refresh-token rotation.
 *
 * Why this exists:
 *   Anthropic rotates the `refresh_token` on EVERY refresh call (verified
 *   empirically via scripts/probe-oauth-refresh.ts). This means whichever
 *   laptop refreshes last invalidates every other laptop's token. The
 *   command lets the user explicitly drive a refresh AND have the server
 *   pick whichever local copy is freshest, so all machines converge.
 *
 * Flow:
 *   1. Acquire the cvault credentials cross-process lock (proper-lockfile
 *      against ~/.claude — same lock Claude Code itself uses).
 *   2. Read the local Keychain blob (when present) to ship as
 *      `localState`. The server uses the embedded
 *      `claudeAiOauth.expiresAt` as a monotonic logical clock to decide
 *      whether the local state is newer than the vault.
 *   3. Call `subscriptions.actions.refreshSub({ slot, localState, force })`.
 *   4. If the returned `contentHash` differs from the local hash AND we
 *      either pulled fresh or refreshed via Anthropic, write the
 *      returned plaintext to the Keychain (atomically, while still under
 *      the lock — `applyEnvelopeUnlocked` because the lock is reentrant
 *      across calls in our process tree but proper-lockfile is NOT
 *      reentrant within one process).
 *   5. Print one line summarizing what happened.
 *   6. Release the lock in the `finally` of `withFileLock`.
 *
 * Exit codes:
 *   0 — any successful outcome (inSync / pulledFresh / adoptedLocal /
 *       refreshedFromAnthropic).
 *   1 — RELOGIN_REQUIRED (re-thrown with an actionable message), any
 *       network/Convex/Keychain hard failure.
 */
import { createHash } from 'node:crypto'

import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { type VaultClient, makeVaultClient } from '../convex/vaultClient'
import { readCredentials } from '../native/credentialStore'
import type { ClaudeSwapEnvelope } from '../native/envelope'
import { applyEnvelopeUnlocked } from '../native/envelope'
import { withFileLock } from '../native/lock'

export interface RunRefreshOptions {
  /**
   * Vault slot to refresh. Required UNLESS `all` is true; mutually
   * exclusive with `all`.
   */
  slot?: number
  /**
   * Refresh every sub the caller owns (via `subscriptions.queries.listForUser`).
   * Per-sub outcomes are summarized at the end; one failure does NOT abort
   * the rest of the batch. Sets `process.exitCode = 1` when any sub failed.
   */
  all?: boolean
  /** Force a server-side Anthropic refresh even when not near expiry. */
  force?: boolean
}

interface RefreshSubResult {
  email: string
  slot: number
  plaintextBlob: string
  contentHash: string
  expiresAt: number
  lastRefreshedAt: number
  action: 'inSync' | 'pulledFresh' | 'adoptedLocal' | 'refreshedFromAnthropic'
}

/**
 * Map the server's action label to a one-line user-facing message.
 * Kept as a pure helper so the rendering is trivially testable.
 *
 * N2: exhaustive `default` so adding a new action label to the union
 * (server side) without updating this switch is a TS compile error
 * rather than a silent fallthrough.
 */
function summarize(result: RefreshSubResult): string {
  switch (result.action) {
    case 'inSync':
      return `Already in sync — no changes needed for ${result.email} (slot ${result.slot.toString()}).`
    case 'pulledFresh':
      return `Updated local from vault — ${result.email} (slot ${result.slot.toString()}).`
    case 'adoptedLocal':
      return `Pushed local to vault — ${result.email} (slot ${result.slot.toString()}).`
    case 'refreshedFromAnthropic':
      return `Refreshed from Anthropic and synced — ${result.email} (slot ${result.slot.toString()}).`
    default: {
      const _exhaustive: never = result.action
      throw new Error(`Unknown refresh action label: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Wrap an envelope around a single-account plaintext blob so
 * `applyEnvelopeUnlocked` can write it. Mirrors the shape used by
 * `cli/src/envelope.ts:buildSingleAccountEnvelope` but kept local to
 * avoid a circular dep — refresh writes to the local credentials with
 * the EXACT plaintext the server returned, not a re-hydrated form.
 *
 * M5: stored plaintexts produced by `cvault add` always contain a
 * `config.oauthAccount` slice (see add.ts:63-69 + envelope.ts buildEnvelope
 * which throws when oauthAccount is missing on capture). If a legacy or
 * tampered plaintext lacks it, we throw early so the user sees an
 * actionable hint instead of a refreshed Keychain that Claude Code
 * can't tell whose account it is.
 */
function buildEnvelopeFromPlaintext(result: RefreshSubResult): ClaudeSwapEnvelope {
  // The server's `plaintextBlob` is the same JSON we sent on `cvault
  // add` — it has `claudeAiOauth` plus `config`, `uuid`,
  // `organizationName`, `organizationUuid`. Round-trip those to the
  // envelope shape `applyEnvelopeUnlocked` expects.
  type CvaultBlob = {
    claudeAiOauth: ClaudeSwapEnvelope['accounts'][number]['credentials']['claudeAiOauth']
    config?: { oauthAccount?: Record<string, unknown> }
    uuid?: string
    organizationUuid?: string
    organizationName?: string
  }
  const blob = JSON.parse(result.plaintextBlob) as CvaultBlob

  // M5: a missing `config.oauthAccount` on a fresh box would mean the
  // refreshed credentials land in the Keychain but `~/.claude.json` is
  // never populated — Claude Code wouldn't know whose account this is.
  // The plaintext SHOULD have `oauthAccount` (cvault add captures it),
  // so a missing one is either legacy data or tampering. Refuse with
  // an actionable hint; the user can `cvault add` on a source machine
  // to re-capture the full slice.
  const oauthAccount = blob.config?.oauthAccount
  if (oauthAccount === undefined || typeof (oauthAccount as { emailAddress?: unknown }).emailAddress !== 'string') {
    throw new Error(
      `Vault row for ${result.email} (slot ${result.slot.toString()}) is missing oauthAccount metadata. ` +
        `Run \`cvault add\` on the machine where you most recently used \`claude\` to recapture this subscription, ` +
        `then \`cvault refresh\` will work on this machine.`
    )
  }

  const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
  const account: ClaudeSwapEnvelope['accounts'][number] = {
    number: result.slot,
    email: result.email,
    uuid: blob.uuid ?? ZERO_UUID,
    added: new Date().toISOString(),
    credentials: { claudeAiOauth: blob.claudeAiOauth },
    config: (blob.config ?? {}) as ClaudeSwapEnvelope['accounts'][number]['config'],
  }
  if (blob.organizationUuid !== undefined) account.organizationUuid = blob.organizationUuid
  if (blob.organizationName !== undefined) account.organizationName = blob.organizationName

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedFrom: 'cvault',
    swapVersion: 'cvault-native-1',
    encrypted: false,
    activeAccountNumber: result.slot,
    accounts: [account],
  }
}

/**
 * Translate a thrown server error into an actionable message. The
 * Convex client wraps `ConvexError({ code: 'RELOGIN_REQUIRED', ... })`
 * into an Error whose message includes "RELOGIN_REQUIRED"; we trip on
 * that substring to render the user-facing remediation prompt.
 */
function maybeReloginError(err: unknown): Error | null {
  const msg = err instanceof Error ? err.message : String(err)
  if (!/RELOGIN_REQUIRED/.test(msg)) return null
  return new Error(
    'Refresh token is dead for this subscription.\n' +
      'Run `cvault add` on the machine where you most recently used `claude` to recapture it.'
  )
}

/**
 * Read the local Keychain (best-effort). Returns the raw blob string
 * + its sha256 hex, or both undefined when the read fails / no local
 * credentials exist. Logs read failures to stderr for diagnostics (S2).
 */
function readLocalForRefresh(): { localState: string | undefined; localHash: string | undefined } {
  let localState: string | undefined
  try {
    const blob = readCredentials()
    localState = blob ?? undefined
  } catch (e) {
    // Treat keychain read failure as "no local state" rather than
    // aborting — the server can still refresh from its side. S2: log
    // the cause to stderr so a sustained Keychain access problem
    // shows up in CI / user reports instead of being silently
    // swallowed (the user would otherwise wonder why local-newer
    // adoption never triggered).
    console.error('cvault refresh: keychain read failed:', e instanceof Error ? e.message : String(e))
    localState = undefined
  }
  const localHash = localState !== undefined ? createHash('sha256').update(localState).digest('hex') : undefined
  return { localState, localHash }
}

/**
 * Drive a single refresh cycle: call the server, decide whether to write
 * local, return the user-facing summary line. Caller owns the cross-
 * process file lock.
 */
async function refreshOneSlotUnlocked(
  client: VaultClient,
  opts: { slot: number; force?: boolean; localState: string | undefined; localHash: string | undefined }
): Promise<RefreshSubResult> {
  const result = (await client.action(api.subscriptions.actions.refreshSub, {
    slot: opts.slot,
    ...(opts.localState !== undefined ? { localState: opts.localState } : {}),
    ...(opts.force === true ? { force: true } : {}),
  })) as RefreshSubResult

  // Decide whether to write the returned plaintext to the Keychain.
  // Two correct cases NOT to write:
  //   - inSync: the server confirmed local matches vault. No-op is right.
  //   - adoptedLocal: the server adopted what we already have. No-op is right.
  // Two cases TO write:
  //   - pulledFresh: vault was newer; copy it down.
  //   - refreshedFromAnthropic: server rotated; copy the new tokens down.
  //
  // Belt-and-braces: also compare hashes — if for some reason the
  // server returns the same plaintext we sent, we still skip the
  // write to avoid a needless Keychain prompt.
  const shouldWrite =
    (result.action === 'pulledFresh' || result.action === 'refreshedFromAnthropic') &&
    result.contentHash !== opts.localHash
  if (shouldWrite) {
    const envelope = buildEnvelopeFromPlaintext(result)
    applyEnvelopeUnlocked(envelope)
  }
  return result
}

interface SubLite {
  slot: number
  email: string
}

/**
 * `cvault refresh --all`: iterate every sub the user owns, calling
 * `refreshSub` per sub. Per-sub failures DO NOT abort the batch — they're
 * tallied into the final summary. Exit code is 0 when all succeeded or
 * skipped (RELOGIN_REQUIRED is a "needs attention" outcome that still
 * counts as a failure for exit code), 1 otherwise.
 */
async function runRefreshAll(
  client: VaultClient,
  opts: { force?: boolean; localState: string | undefined; localHash: string | undefined }
): Promise<void> {
  const subs = (await client.query(api.subscriptions.queries.listForUser, {})) as SubLite[]
  if (subs.length === 0) {
    console.log('No subscriptions in the vault to refresh.')
    return
  }

  console.log('Refreshing all subs...')
  let okCount = 0
  let failCount = 0
  for (let i = 0; i < subs.length; i += 1) {
    const target = subs[i]
    if (target === undefined) continue
    const progress = `[${(i + 1).toString()}/${subs.length.toString()}]`
    const emailLabel = target.email
    try {
      const result = await refreshOneSlotUnlocked(client, {
        slot: target.slot,
        ...(opts.force === true ? { force: true } : {}),
        localState: opts.localState,
        localHash: opts.localHash,
      })
      okCount += 1
      // Per-sub outcome line. Action label drives the symbol so users
      // can scan a long list quickly: ✓ for clean outcomes, ⚠ when
      // attention is needed (RELOGIN — handled in the catch below).
      console.log(`  ${progress} ${emailLabel}  ✓ ${result.action}`)
    } catch (err) {
      failCount += 1
      const relogin = maybeReloginError(err)
      if (relogin) {
        // Don't rethrow during --all — surface inline + keep going.
        console.log(`  ${progress} ${emailLabel}  ⚠ RELOGIN_REQUIRED  (run \`cvault add\` on source machine)`)
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`  ${progress} ${emailLabel}  ✗ ${msg.split('\n')[0] ?? msg}`)
      }
    }
  }

  console.log('')
  if (failCount === 0) {
    console.log(`Summary: ${okCount.toString()} ok`)
  } else {
    console.log(`Summary: ${okCount.toString()} ok, ${failCount.toString()} needs attention`)
    // Set the exit code so shell scripts / CI can branch on it. We
    // can't `process.exit(1)` here because the caller may still be
    // composing a longer run; let citty propagate this on its own.
    process.exitCode = 1
  }
}

export async function runRefresh(opts: RunRefreshOptions): Promise<void> {
  if (opts.all !== true && opts.slot === undefined) {
    throw new Error('cvault refresh: provide --slot <n> or --all')
  }

  const client: VaultClient = await makeVaultClient()

  // Hold the cross-process lock around the whole cycle: read local →
  // call server → maybe-write local. Any other cvault or Claude Code
  // process trying to read/write the same Keychain entry is gated.
  // For --all we hold the lock across ALL subs because the per-sub
  // writes mutate the same `~/.claude.json` slice; serialized batch
  // matches the single-sub semantics.
  await withFileLock(async () => {
    const { localState, localHash } = readLocalForRefresh()

    if (opts.all === true) {
      await runRefreshAll(client, {
        ...(opts.force === true ? { force: true } : {}),
        localState,
        localHash,
      })
      return
    }

    // Single-slot path.
    if (opts.slot === undefined) {
      // Defensive — already checked above, but the type narrowing
      // doesn't carry through the closure boundary.
      throw new Error('cvault refresh: --slot is required when --all is not set')
    }
    let result: RefreshSubResult
    try {
      result = await refreshOneSlotUnlocked(client, {
        slot: opts.slot,
        ...(opts.force === true ? { force: true } : {}),
        localState,
        localHash,
      })
    } catch (err) {
      const relogin = maybeReloginError(err)
      if (relogin) throw relogin
      throw err
    }
    console.log(summarize(result))
  })
}

export const refreshCommand = defineCommand({
  meta: {
    name: 'refresh',
    description:
      'Refresh OAuth tokens, coordinating local Keychain and the vault across laptops. ' +
      'Pass --slot <n> to refresh one sub, or --all to refresh every sub the user owns.',
  },
  args: {
    slot: {
      type: 'string',
      description: 'Vault slot number to refresh. Required unless --all is set.',
      required: false,
    },
    all: {
      type: 'boolean',
      description: 'Refresh every sub the caller owns. Mutually exclusive with --slot.',
      required: false,
      default: false,
    },
    force: {
      type: 'boolean',
      description: 'Force a server-side Anthropic refresh even when not near expiry.',
      required: false,
      default: false,
    },
  },
  async run({ args }) {
    if (args.all === true) {
      await runRefresh({
        all: true,
        ...(args.force === true ? { force: true } : {}),
      })
      return
    }
    if (typeof args.slot !== 'string' || args.slot.length === 0) {
      throw new Error('cvault refresh: provide --slot <n> or --all')
    }
    const slot = Number.parseInt(args.slot, 10)
    if (Number.isNaN(slot)) {
      throw new Error(`--slot must be a number, got ${args.slot}`)
    }
    await runRefresh({ slot, force: args.force })
  },
})
