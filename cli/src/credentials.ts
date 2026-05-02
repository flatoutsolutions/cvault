import { readGlobalConfig } from './native/claudeConfig'
import { readCredentials } from './native/credentialStore'
import type { ClaudeSwapEnvelope } from './native/envelope'
import { applyEnvelope, buildEnvelope, clearActive as nativeClearActive } from './native/envelope'

/**
 * Façade for the active Claude Code credentials, backed by the native
 * module under `cli/src/native/`.
 *
 * cvault used to shell out to `claude-swap` (Python) for every Keychain
 * op. As of 2026-05-02 the project owns the Keychain ops directly (zero
 * ext deps, single-binary install). This file is the migration's
 * outward-facing surface — command files import from here, and the legacy
 * verb names (`exportAccount`, `importEnvelope`, `switchTo`, …) are
 * preserved as thin wrappers around the native primitives so commands and
 * scenario tests don't have to know which subsystem stores credentials.
 *
 * Mapping (legacy claude-swap → native primitive):
 *   - `exportAccount(slot)` → `buildEnvelope({ number: slot })`
 *   - `exportAll()` → same as `exportAccount` (single-account on native)
 *   - `importEnvelope(env)` → `applyEnvelope(env)`
 *   - `switchTo(slot)` → no-op (on native, the active credentials *are*
 *     whatever was last imported; there is no per-slot backup pool)
 *   - `removeAccount(slot)` → `clearActive()` (wipes keychain + claude.json)
 *   - `purge()` → same as `removeAccount` on native
 *   - `status()` — synthesized from the active oauthAccount in claude.json
 *   - `addAccountInteractive()` → spawns `claude` directly
 *   - `ClaudeSwapError` / `ClaudeSwapMissingError` — re-exported from the
 *     native error classes (`NativeKeychainError`, `ClaudeCliMissingError`)
 *     so existing `instanceof` narrowing keeps working.
 *
 * The `ClaudeSwapAccount` / `ClaudeSwapEnvelope` type names are preserved
 * verbatim because they identify the wire-format envelope Convex stores;
 * renaming would force a coordinated backend + CLI deploy.
 */
export {
  applyEnvelope,
  buildEnvelope,
  clearActive,
  type ClaudeSwapAccount,
  type ClaudeSwapEnvelope,
} from './native/envelope'
export { addAccountInteractive } from './native/claudeCli'
export {
  ClaudeCliMissingError as ClaudeSwapMissingError,
  NativeKeychainError as ClaudeSwapError,
} from './native/errors'

/**
 * Slot number cvault used to encode in `claude-swap`'s sequence file.
 * On native there's only one active account at a time, so we always
 * report slot 1. The value is irrelevant to functionality — callers parse
 * the email out of `status()` for routing.
 */
const NATIVE_SLOT = 1

/**
 * Legacy: `claude-swap --export - --account <slot> --full`.
 *
 * On native, `slotOrEmail` is ignored — there is exactly one active
 * account on the machine. The arg is preserved in the signature so command
 * code (`add.ts`) doesn't have to change yet.
 */
export function exportAccount(_slotOrEmail: string | number): ClaudeSwapEnvelope {
  return buildEnvelope({ number: NATIVE_SLOT })
}

/** Legacy: `claude-swap --export -`. Same as `exportAccount` on native. */
export function exportAll(): ClaudeSwapEnvelope {
  return buildEnvelope({ number: NATIVE_SLOT })
}

/**
 * Legacy: `claude-swap --import - [--force]`. The `force` flag is unused
 * on native (we always overwrite the active credentials). Returns a
 * Promise because native `applyEnvelope` acquires a cross-process lock
 * before its read-modify-write cycle.
 */
export async function importEnvelope(envelope: ClaudeSwapEnvelope, _force = false): Promise<void> {
  await applyEnvelope(envelope)
}

/**
 * Legacy: `claude-swap --switch-to <id>`. On native this is a no-op
 * because the active credentials *are* whatever was last imported — there
 * is no per-slot backup pool. Callers (`switch.ts`, `sync.ts`) call this
 * after `importEnvelope` so the post-condition is already satisfied.
 */
export function switchTo(_slotOrEmail: string | number): void {
  // intentionally empty on native
}

/**
 * Legacy: `claude-swap --remove-account <id>`. On native this clears the
 * Keychain entry + the `oauthAccount` slice in `~/.claude.json`. There's
 * no per-slot pool to renumber. Returns a Promise because native
 * `clearActive` acquires the same lock as `applyEnvelope`.
 */
export async function removeAccount(_slotOrEmail: string | number): Promise<void> {
  await nativeClearActive()
}

/**
 * Legacy: `claude-swap --purge`. On native we have no concept of "every
 * managed account" — there is exactly one active account. Equivalent to
 * `removeAccount`.
 */
export async function purge(): Promise<void> {
  await nativeClearActive()
}

/**
 * Typed view of the currently-active local account.
 *
 * Returns `null` ONLY for the genuine "not signed in" cases:
 *   - The credentials store has no entry on this machine (fresh
 *     install, or `cvault clean` was run).
 *   - The credentials store has an entry but `~/.claude.json` is
 *     missing the `oauthAccount.emailAddress` slice (the user has
 *     credentials but Claude Code never ran to populate the metadata
 *     — happens with API-key-only installs).
 *
 * Throws `NativeKeychainError` (or other underlying errors) for
 * KEYCHAIN ACCESS FAILURES — locked Keychain, interaction required,
 * ACL denied, etc. The reason: callers (`list.ts`, `status.ts`) need
 * to distinguish "no active sub" from "we couldn't read the active
 * sub" because the user-visible message differs ("you have no subs"
 * vs. "your Keychain is locked, run from Terminal").
 *
 * Prefer this over `status()` in new code — there is no string parsing
 * involved, and callers can match by email against the Convex
 * `listForUser` result without assuming any particular slot number.
 */
export interface ActiveAccount {
  email: string
  organizationName?: string
  organizationUuid?: string
  accountUuid?: string
}

export function getActiveAccount(): ActiveAccount | null {
  // readCredentials throws on Keychain errors (locked, ACL, etc.) and
  // returns null only for the genuine "no entry" status (exit 44 on
  // macOS, file-absent on Linux/WSL). The throw propagates — that's
  // L4d behavior: callers decide whether to render an error or skip
  // the active marker.
  if (readCredentials() === null) return null

  // readGlobalConfig throws on parse errors (malformed claude.json)
  // and returns null only when the file does not exist. Both throws
  // propagate; null + missing oauthAccount maps to "no email" → null.
  const cfg = readGlobalConfig()
  const oauthAccount = cfg?.oauthAccount
  const email = typeof oauthAccount?.emailAddress === 'string' ? oauthAccount.emailAddress : undefined
  if (email === undefined) return null

  const out: ActiveAccount = { email }
  if (typeof oauthAccount?.organizationName === 'string' && oauthAccount.organizationName.length > 0) {
    out.organizationName = oauthAccount.organizationName
  }
  if (typeof oauthAccount?.organizationUuid === 'string' && oauthAccount.organizationUuid.length > 0) {
    out.organizationUuid = oauthAccount.organizationUuid
  }
  if (typeof oauthAccount?.accountUuid === 'string' && oauthAccount.accountUuid.length > 0) {
    out.accountUuid = oauthAccount.accountUuid
  }
  return out
}

/**
 * Legacy stdout-format view, retained for callers that haven't migrated
 * to `getActiveAccount()` yet. Synthesizes the format `claude-swap
 * --status` produced. Note: the slot number in this string is always
 * "1" (native has one active credential); callers MUST NOT key matching
 * logic off the slot. Match by email instead.
 */
export function status(): string {
  const active = getActiveAccount()
  if (active === null) return 'No active account\n'
  const orgSuffix = active.organizationName !== undefined ? ` [${active.organizationName}]` : ''
  return `Status: Account-${NATIVE_SLOT.toString()} (${active.email}${orgSuffix})\n  Total managed accounts: 1\n`
}
