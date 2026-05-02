/**
 * macOS Keychain authority for Claude Code's "active" OAuth credentials.
 *
 * Claude Code stores its currently-signed-in account's tokens in the macOS
 * login Keychain under:
 *   service: "Claude Code-credentials"   (pinned by Claude Code itself)
 *   account: $USER                        (fallback "user")
 *
 * The blob is the verbatim JSON `{ claudeAiOauth: { accessToken, ... } }`
 * (see `envelope.ts` for the type). cvault reads/writes the same entry so
 * Claude Code picks up the active sub immediately after a `cvault switch`.
 *
 * All three operations (read, write, delete) shell out to the
 * `/usr/bin/security` CLI. We deliberately do NOT use `bun:ffi` against
 * `Security.framework` — see `writeActiveCredentials` for the trade-off.
 *
 * Hardening rules (per the security-CLI research brief):
 *  - **Typed exit-code map.** `security` returns small int codes (44 =
 *    not-found, 36 = interaction-required, 51 = ACL denied, 128 =
 *    user-cancelled). We map each to a typed `KeychainErrorKind` rather
 *    than collapsing into one opaque error, so callers can offer
 *    actionable hints.
 *  - **30-second timeout.** SecurityAgent prompts can block several
 *    seconds on first-time keychain unlock. On Bun timeout we surface
 *    `interaction-required` (not a generic timeout).
 *  - **Output handling.** `find -w` emits the password on stdout + a
 *    single trailing newline; we strip exactly one (NOT `.trim()`).
 *  - **Platform guard.** `runSecurity` throws `PlatformUnsupportedError`
 *    if called on non-Darwin — defense in depth on top of
 *    `credentialStore.ts`'s top-level dispatch.
 *  - **stderr redaction.** Error messages run through `redactTokens()`
 *    before being attached to thrown errors, so a buggy `security` build
 *    that echoed the input can't leak it through our user-visible output.
 */
import type { SyncSubprocess } from 'bun'

import { redactTokens } from '../render/redact'
import { NativeKeychainError, PlatformUnsupportedError } from './errors'

/** Claude Code's pinned Keychain service name. Do not change. */
export const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** macOS `security(1)` exit codes — not formally documented by Apple, stable. */
const EXIT_USAGE = 2
const EXIT_INTERACTION_NOT_ALLOWED = 36
const EXIT_NOT_FOUND = 44
const EXIT_DUPLICATE_ITEM = 45
const EXIT_AUTH_DENIED = 51
const EXIT_USER_CANCELLED = 128

/** Hard timeout for any single `security` call. */
const SPAWN_TIMEOUT_MS = 30_000

/** Resolve the keychain account ($USER, fallback "user"). */
function getAccount(): string {
  const u = process.env.USER
  return u !== undefined && u.length > 0 ? u : 'user'
}

/**
 * Categorized failure modes from `security`. Callers can branch on `kind`
 * to render actionable hints (e.g. "run interactively from Terminal once
 * to populate the SSH-blocked Keychain"); the `stderr` carries the raw
 * message for debugging.
 *
 * `not-found` is a status — never propagate as throw from `read`/`delete`.
 */
export type KeychainErrorKind =
  | 'usage'
  | 'interaction-required'
  | 'not-found'
  | 'duplicate-item'
  | 'auth-denied'
  | 'cancelled'
  | 'unknown'

interface RunOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
  /** True when `Bun.spawnSync` killed the proc on timeout. */
  timedOut: boolean
}

interface RunOpts {
  /** UTF-8 string piped to stdin. */
  stdin?: string
}

function runSecurity(args: readonly string[], opts: RunOpts = {}): RunOutcome {
  // Defense in depth: even though `credentialStore.ts` dispatches by
  // platform, importing this module directly should fail loud on
  // anything other than darwin. `security` doesn't exist on Linux/WSL.
  if (process.platform !== 'darwin') {
    throw new PlatformUnsupportedError(process.platform)
  }

  let proc: SyncSubprocess<'pipe' | 'ignore', 'pipe'>
  try {
    proc = Bun.spawnSync({
      cmd: ['security', ...args],
      stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin, 'utf8') : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: SPAWN_TIMEOUT_MS,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new NativeKeychainError(`failed to exec \`security\`: ${redactTokens(msg)}`, null, '')
  }

  // Bun returns null for `exitCode` and a non-zero `signalCode` when the
  // process was killed (typically SIGTERM after timeout or user Ctrl-C).
  // We treat null exit + signal as a timeout-style "interaction required"
  // since the most common cause is a SecurityAgent prompt blocking
  // longer than the timeout.
  const timedOut = proc.exitCode === null

  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    timedOut,
  }
}

/** Map a non-zero `security` exit code to a categorized error kind. */
function classifyExit(code: number | null, timedOut: boolean): KeychainErrorKind {
  if (timedOut) return 'interaction-required'
  switch (code) {
    case EXIT_USAGE:
      return 'usage'
    case EXIT_INTERACTION_NOT_ALLOWED:
      return 'interaction-required'
    case EXIT_NOT_FOUND:
      return 'not-found'
    case EXIT_DUPLICATE_ITEM:
      return 'duplicate-item'
    case EXIT_AUTH_DENIED:
      return 'auth-denied'
    case EXIT_USER_CANCELLED:
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** Build a remediation hint matching the error kind. */
function hint(kind: KeychainErrorKind): string {
  switch (kind) {
    case 'interaction-required':
      return (
        'Keychain access is blocked from this session (likely SSH or a headless context). ' +
        'Run `cvault status` once interactively from Terminal so macOS can prompt for unlock.'
      )
    case 'auth-denied':
      return (
        'Keychain ACL denied access — the existing entry may have been written by another ' +
        'app (legacy `claude-swap`?). Run `cvault add` to re-capture credentials cvault owns.'
      )
    case 'cancelled':
      return 'You cancelled the Keychain prompt. Re-run the command and approve to continue.'
    case 'usage':
      return 'Internal error: malformed `security` invocation. Please file a bug.'
    case 'duplicate-item':
      return 'Internal error: `add-generic-password` rejected an overwrite. Please file a bug.'
    case 'not-found':
      // `not-found` is a status, not a thrown error. The hint is unused.
      return ''
    case 'unknown':
      return 'Unexpected `security` exit code. Try `security list-keychains` to confirm Keychain access.'
  }
}

function throwKeychainError(verb: string, out: RunOutcome): never {
  const kind = classifyExit(out.exitCode, out.timedOut)
  const codeLabel = out.timedOut ? 'TIMEOUT' : String(out.exitCode)
  throw new NativeKeychainError(
    `security ${verb} (${kind}, exit ${codeLabel}): ${redactTokens(out.stderr.trim())}\n${hint(kind)}`,
    out.exitCode,
    out.stderr
  )
}

/**
 * Read the active Claude Code credentials blob from the Keychain. Returns
 * `null` when the keychain item is absent (the user has never signed into
 * Claude Code on this machine, or `cvault clean` was run).
 *
 * Other failure kinds (interaction-required, auth-denied, cancelled,
 * unknown) throw `NativeKeychainError` with a categorized hint.
 */
export function readActiveCredentials(): string | null {
  const account = getAccount()
  const out = runSecurity(['find-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE, '-w'])
  if (out.exitCode === 0) {
    // `security -w` always emits exactly one trailing newline. Strip
    // exactly one (NOT `.trim()` — the OAuth blob could in principle
    // contain leading/trailing whitespace inside a quoted JSON value
    // that we must preserve).
    return out.stdout.endsWith('\n') ? out.stdout.slice(0, -1) : out.stdout
  }
  if (classifyExit(out.exitCode, out.timedOut) === 'not-found') return null
  throwKeychainError('find-generic-password', out)
}

/**
 * macOS Keychain credentials writer using `security add-generic-password`.
 *
 * Trade-off (verified during build):
 *
 * - The `-w "<value>"` argv form is used here, which leaks the password
 *   via `ps auxww` for the call's lifetime (~10s of ms).
 * - The stdin-prompt form (`-w` with no value, password piped to stdin)
 *   silently truncates at 128 bytes — pinned by the integration test at
 *   `tests/integration/keychainRoundtrip.test.ts`. Our OAuth blob is
 *   180-250 bytes, so stdin form is unusable.
 * - `bun:ffi` to `SecKeychainAddGenericPassword` works (verified during
 *   the build spike), but items written by the cvault binary have a
 *   different Keychain ACL than items written by the system `security`
 *   CLI or by Claude Code itself. This causes a SecurityAgent prompt on
 *   every read across the trust boundary, which is unacceptable UX.
 *   Verified empirically — every cross-binary read prompted the user.
 * - The accepted approach: stay inside `/usr/bin/security` for both read
 *   and write so all cvault-managed items share the same Apple-signed
 *   binary's ACL — same as `claude-swap`'s behavior, no prompt loops.
 *
 * Threat model:
 * - cvault is for single-user developer machines. The leak window is
 *   only exploitable by a same-UID adversary on the local box, who can
 *   already read `~/.claude.json` and (on Linux) the credentials file.
 * - DO NOT use cvault on multi-tenant machines (shared CI runners, build
 *   farms, classroom Macs). README's "Security model" section documents
 *   this.
 *
 * `-U` makes the operation idempotent: `add-generic-password` updates an
 * existing entry rather than exiting 45.
 */
export function writeActiveCredentials(blob: string): void {
  const account = getAccount()
  const out = runSecurity(['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', blob])
  if (out.exitCode !== 0) {
    throwKeychainError('add-generic-password', out)
  }
}

/**
 * Remove the credentials blob. A missing entry (exit 44) is treated as
 * a no-op since the post-condition (entry absent) is already satisfied.
 */
export function deleteActiveCredentials(): void {
  const account = getAccount()
  const out = runSecurity(['delete-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE])
  if (out.exitCode === 0) return
  if (classifyExit(out.exitCode, out.timedOut) === 'not-found') return
  throwKeychainError('delete-generic-password', out)
}
