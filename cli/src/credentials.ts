import { readGlobalConfig } from './native/claudeConfig'
import { readCredentials } from './native/credentialStore'
import type { ClaudeSwapEnvelope } from './native/envelope'
import { applyEnvelope, buildEnvelope, clearActive as nativeClearActive } from './native/envelope'

/**
 * Façade for the active Claude Code credentials.
 *
 * Command files (`add.ts`, `switch.ts`, etc.) import their verbs
 * (`exportAccount`, `importEnvelope`, `removeAccount`, `purge`,
 * `getActiveAccount`, …) from here so they stay decoupled from where
 * credentials are actually stored. The implementations live under
 * `cli/src/native/`:
 *
 *   - `keychain.ts` (macOS via `security`)
 *   - `credentialsFile.ts` (Linux/WSL via `~/.claude/.credentials.json`)
 *   - `claudeConfig.ts` (`~/.claude.json` `oauthAccount` slice)
 *   - `envelope.ts` (build/apply Convex envelopes; cross-process locked)
 *   - `claudeCli.ts` (spawn `claude` interactively for OAuth)
 *
 * The `ClaudeSwapAccount` / `ClaudeSwapEnvelope` type names AND the
 * `ClaudeSwapError` / `ClaudeSwapMissingError` re-exports are preserved
 * verbatim from the legacy claude-swap-backed era. Rationale: the
 * envelope shape is the wire format Convex stores, and changing the
 * names would force a coordinated backend + CLI deploy. The errors are
 * aliases for `NativeKeychainError` / `ClaudeCliMissingError` so
 * existing `instanceof` narrowing in caller code keeps working.
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
 * Native has exactly one active credential on a machine at any time;
 * the slot number in synthesized envelopes is always 1. Callers must
 * route by email, not slot.
 */
const NATIVE_SLOT = 1

/**
 * Capture the currently-active credentials + `~/.claude.json` slice as
 * an envelope ready to ship to Convex. The `slotOrEmail` arg is
 * intentionally ignored — it exists so command-side code can keep its
 * signature stable across the migration. On native there is exactly one
 * active account on this machine.
 */
export function exportAccount(_slotOrEmail: string | number): ClaudeSwapEnvelope {
  return buildEnvelope({ number: NATIVE_SLOT })
}

/** Same single-account envelope as `exportAccount` (no multi-account on native). */
export function exportAll(): ClaudeSwapEnvelope {
  return buildEnvelope({ number: NATIVE_SLOT })
}

/**
 * Apply an envelope: write the credentials store + the `oauthAccount`
 * slice in `~/.claude.json`. The `force` flag is accepted for back-compat
 * with the legacy verb signature but is unused — native always
 * overwrites the active credentials. Returns a Promise because the
 * underlying `applyEnvelope` acquires a cross-process file lock before
 * its read-modify-write cycle.
 */
export async function importEnvelope(envelope: ClaudeSwapEnvelope, _force = false): Promise<void> {
  await applyEnvelope(envelope)
}

/**
 * No-op on native: the active credentials *are* whatever was last
 * imported. The verb is retained so callers (`switch.ts`, `sync.ts`)
 * can keep their post-import sequence unchanged from the legacy era;
 * the post-condition (active sub = imported sub) is already satisfied
 * by `importEnvelope`.
 */
export function switchTo(_slotOrEmail: string | number): void {
  // intentionally empty on native
}

/**
 * Clear the active credentials store + the `oauthAccount` slice in
 * `~/.claude.json`. The `slotOrEmail` arg is ignored — there is exactly
 * one active credential on the machine and clearing is unconditional.
 * Returns a Promise because the underlying `clearActive` acquires the
 * same file lock as `applyEnvelope`.
 */
export async function removeAccount(_slotOrEmail: string | number): Promise<void> {
  await nativeClearActive()
}

/**
 * Synonym for `removeAccount` — clears the single active credential.
 * Used by `cvault clean` for naming clarity ("purge everything local").
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
