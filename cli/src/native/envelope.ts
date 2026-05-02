/**
 * Native envelope build/apply.
 *
 * The envelope shape is the wire format Convex stores and the format
 * `claude-swap --import` accepted in the legacy path. Convex still
 * accepts old envelopes (shape version 1, swapVersion `0.10.x`) on
 * import, so we don't change the type — we just stamp a new
 * `swapVersion` value (`cvault-native-1`) on what we PRODUCE so future
 * tooling can tell native exports from legacy ones.
 *
 * Fields:
 *  - `accessToken`/`refreshToken`/`expiresAt`/`scopes`/`subscriptionType`
 *    come from the active credentials store (Keychain on macOS, file on
 *    Linux/WSL).
 *  - `email`, `uuid`, `organizationUuid`, `organizationName` come from
 *    `~/.claude.json`'s `oauthAccount` slice.
 *  - `config.oauthAccount` mirrors the entire oauthAccount object so a
 *    later switch on a different machine can rebuild it.
 *  - `number` is supplied by the caller (cvault owns slot mapping; on
 *    native there's only ever one active account on this machine).
 *  - `added` is `new Date().toISOString()` at build time.
 *
 * On `applyEnvelope`, we write both the keychain/file backend and the
 * claude.json slice. After this call returns, Claude Code itself can
 * immediately use the active sub.
 */
import { clearOauthAccount, readGlobalConfig, writeOauthAccount } from './claudeConfig'
import { deleteCredentials, readCredentials, writeCredentials } from './credentialStore'
import { withFileLock } from './lock'
import { getPlatform } from './platform'

// ---------------------------------------------------------------------------
// Types — preserved verbatim from the legacy claude-swap-backed module so
// the Convex wire format and on-disk envelope layout do not change.
// (The names still bear `ClaudeSwap` because that's the wire-format
// identifier; renaming would force a coordinated backend + CLI deploy.)
// ---------------------------------------------------------------------------

/** A single account inside a `claude-swap --export -` envelope. */
export interface ClaudeSwapAccount {
  number: number
  email: string
  uuid: string
  organizationUuid?: string
  organizationName?: string
  added: string
  credentials: {
    claudeAiOauth: {
      accessToken: string
      refreshToken: string
      expiresAt: number
      scopes: string[]
      subscriptionType: 'max' | 'pro'
    }
  }
  config?: { oauthAccount?: Record<string, unknown> }
}

/** The full `claude-swap --export -` envelope shape. */
export interface ClaudeSwapEnvelope {
  version: 1
  exportedAt: string
  exportedFrom: string
  swapVersion: string
  encrypted: false
  activeAccountNumber: number
  accounts: ClaudeSwapAccount[]
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
const SWAP_VERSION = 'cvault-native-1'

interface BuildEnvelopeOptions {
  /** Slot number cvault has assigned to this account. */
  number: number
}

/**
 * Read the active credentials + ~/.claude.json and synthesize an envelope.
 *
 * Throws when no credentials are stored locally (the user has never signed
 * into Claude Code on this machine, or `cvault clean` was run) — the
 * caller cannot proceed without an active account.
 */
export function buildEnvelope(opts: BuildEnvelopeOptions): ClaudeSwapEnvelope {
  const blob = readCredentials()
  if (blob === null) {
    throw new Error(
      'No active Claude Code credentials on this machine. ' +
        'Run `cvault add` (or `claude` directly) to sign in first.'
    )
  }

  let credentials: ClaudeSwapAccount['credentials']
  try {
    const parsed = JSON.parse(blob) as unknown
    if (typeof parsed !== 'object' || parsed === null || !('claudeAiOauth' in parsed)) {
      throw new Error('keychain blob has no `claudeAiOauth` wrapper')
    }
    credentials = parsed as ClaudeSwapAccount['credentials']
  } catch (err) {
    if (err instanceof Error && /claudeAiOauth/i.test(err.message)) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to parse credentials JSON: ${msg}`)
  }

  const cfg = readGlobalConfig()
  const oauthAccount = cfg?.oauthAccount
  if (oauthAccount === undefined || typeof oauthAccount.emailAddress !== 'string') {
    throw new Error(
      `~/.claude.json has no \`oauthAccount.emailAddress\`. ` +
        `Either run \`claude\` once on this machine to populate it, ` +
        `or run \`cvault sync\` to pull a previously-captured account from the vault.`
    )
  }

  // L4j: single `now` for both `exportedAt` and `account.added` so the
  // two timestamps are always identical for a given build call (avoids
  // a sub-millisecond skew that has bitten downstream sorts elsewhere).
  const now = new Date().toISOString()

  const account: ClaudeSwapAccount = {
    number: opts.number,
    email: oauthAccount.emailAddress,
    uuid: typeof oauthAccount.accountUuid === 'string' ? oauthAccount.accountUuid : ZERO_UUID,
    organizationName: typeof oauthAccount.organizationName === 'string' ? oauthAccount.organizationName : '',
    added: now,
    credentials,
    config: { oauthAccount },
  }
  if (typeof oauthAccount.organizationUuid === 'string') {
    account.organizationUuid = oauthAccount.organizationUuid
  }

  return {
    version: 1,
    exportedAt: now,
    exportedFrom: getPlatform(),
    swapVersion: SWAP_VERSION,
    encrypted: false,
    activeAccountNumber: opts.number,
    accounts: [account],
  }
}

/**
 * Write the envelope's first account into the local credentials store +
 * `~/.claude.json`. After this returns, Claude Code is signed in as that
 * account.
 *
 * On native there's no concept of "all accounts on the machine" because
 * the OS only stores one active account at a time. Multi-account
 * envelopes are still accepted (we just take `accounts[0]` since import
 * only ever ships single-account envelopes from cvault).
 *
 * Concurrency + atomicity (R1):
 *  - The whole read-snapshot + two-write cycle is wrapped in a
 *    cross-process file lock so two `cvault` invocations cannot
 *    interleave their reads and writes.
 *  - Before the writes, we snapshot BOTH the current credentials AND
 *    the current `oauthAccount` slice.
 *  - If step 2 (claude.json) throws, the catch block rolls back BOTH
 *    halves to the snapshot. The reason both must roll back: writing
 *    `oauthAccount` is itself two ops (atomic temp+rename, then chmod);
 *    a failure between rename and chmod leaves the new oauthAccount on
 *    disk while the throw signals failure. Symmetric rollback covers
 *    that partial-success window.
 *  - If a rollback step itself fails, we log to stderr (the user is now
 *    in a partially-rotated state we can't fix programmatically) and
 *    rethrow the original error so the caller sees the right cause.
 */
export async function applyEnvelope(env: ClaudeSwapEnvelope): Promise<void> {
  const account = env.accounts[0]
  if (!account) {
    throw new Error('cannot apply envelope with no accounts')
  }

  await withFileLock(() => {
    // Snapshot current state for rollback. `null`/`undefined` are valid
    // pre-states (no credentials yet, no oauthAccount yet); rollback
    // paths handle them.
    const priorCreds = readCredentials()
    const priorCfg = readGlobalConfig()
    const priorOauthAccount = priorCfg?.oauthAccount

    const newBlob = JSON.stringify(account.credentials)

    // Step 1 — credentials. Stringify the `credentials` slot exactly as
    // the Keychain blob (Claude Code reads the whole
    // `{ claudeAiOauth: ... }`).
    writeCredentials(newBlob)

    // Step 2 — `~/.claude.json`'s `oauthAccount` slice. Use
    // `writeOauthAccount` so sibling keys (telemetry IDs, feature
    // flags) are preserved. If this throws, roll back step 1 AND
    // step 2 (the latter may have partially succeeded — see docstring).
    if (account.config?.oauthAccount !== undefined) {
      try {
        writeOauthAccount(account.config.oauthAccount)
      } catch (err) {
        // Symmetric rollback (R1).
        try {
          if (priorCreds === null) {
            deleteCredentials()
          } else {
            writeCredentials(priorCreds)
          }
        } catch {
          console.error(
            'error: failed to roll back credentials after claude.json write failed; local state may be inconsistent'
          )
        }
        try {
          if (priorOauthAccount === undefined) {
            clearOauthAccount()
          } else {
            writeOauthAccount(priorOauthAccount)
          }
        } catch {
          console.error('error: failed to roll back ~/.claude.json oauthAccount after the original write failed')
        }
        throw err
      }
    }
  })
}

/**
 * Clear all native state for the active account: credentials + the
 * `oauthAccount` slice in `~/.claude.json`. Used by `cvault remove` and
 * `cvault clean`.
 *
 * Wrapped in the same file lock as `applyEnvelope` so concurrent CLI
 * invocations cannot interleave a clear with a pending apply.
 */
export async function clearActive(): Promise<void> {
  await withFileLock(() => {
    const priorCreds = readCredentials()
    deleteCredentials()
    try {
      clearOauthAccount()
    } catch (err) {
      // Roll back the credentials delete so we don't leave the user in
      // a half-cleared state.
      try {
        if (priorCreds !== null) writeCredentials(priorCreds)
      } catch {
        console.error('error: failed to restore credentials after clearOauthAccount failure')
      }
      throw err
    }
  })
}
