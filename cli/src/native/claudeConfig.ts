/**
 * Read/merge/clear the `oauthAccount` slice of `~/.claude.json`.
 *
 * Claude Code persists per-user metadata (`emailAddress`, `accountUuid`,
 * `organizationUuid`, `organizationName`, `seatTier`, `displayName`, plus
 * a long tail of UI-side fields) in this file alongside other keys it
 * owns (caches, feature flags, telemetry IDs).
 *
 * Constraint: cvault MUST NOT clobber the sibling keys. We always
 * read-modify-write — never overwrite the entire file.
 *
 * Atomic write pattern (mirrors claude-swap's `_atomic_write_file`):
 *  1. Read existing JSON (or `{}` if missing)
 *  2. Merge in the new `oauthAccount` (or remove it for `clear`)
 *  3. Write to `<path>.<pid>.tmp`
 *  4. JSON.parse roundtrip on the tmp content (guards against malformed writes)
 *  5. rename tmp over `<path>` (POSIX atomic on the same fs)
 *  6. chmod 0600
 */
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

import { getGlobalConfigPath } from './paths'

const FILE_MODE = 0o600

/** Parsed shape of `~/.claude.json` — opaque except for `oauthAccount`. */
export interface ClaudeGlobalConfig {
  oauthAccount?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Read and parse `~/.claude.json`. Returns `null` when the file doesn't
 * exist (fresh machine). Throws when the file exists but isn't valid JSON
 * — silently coercing to `{}` would risk overwriting a real (but
 * temporarily corrupted) config.
 */
export function readGlobalConfig(): ClaudeGlobalConfig | null {
  const path = getGlobalConfigPath()
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to parse JSON at ${path}: ${msg}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`)
  }
  return parsed as ClaudeGlobalConfig
}

/**
 * Atomically write `data` to the global config path with mode 0600.
 *
 * Steps:
 *  1. Stringify (catches BigInt etc. before any file write)
 *  2. JSON.parse roundtrip — guards against producing a file that
 *     doesn't parse back to the same shape (e.g. a key got serialized
 *     as `[object Object]` somehow).
 *  3. Write tmp + rename + chmod.
 */
function writeGlobalConfigAtomic(data: ClaudeGlobalConfig): void {
  const path = getGlobalConfigPath()
  const json = JSON.stringify(data, null, 2)
  // Roundtrip validation: parse what we just stringified and confirm we
  // get back something structurally equivalent. This is cheap and catches
  // serializer-introduced corruption.
  JSON.parse(json)

  const tmpPath = `${path}.${process.pid.toString()}.tmp`
  try {
    writeFileSync(tmpPath, json, { mode: FILE_MODE, encoding: 'utf8' })
    // POSIX `rename(2)` preserves the source inode's metadata, so a
    // single chmod on the tmp file is enough — no need to chmod the
    // final path again. (L4e: dropped the redundant post-rename chmod.)
    if (process.platform !== 'win32') {
      chmodSync(tmpPath, FILE_MODE)
    }
    renameSync(tmpPath, path)
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // ignore — best effort
      }
    }
  }
}

/**
 * Merge `oauthAccount` into the existing config, preserving sibling keys.
 * Creates the file if missing. Throws if the merge would not roundtrip
 * through JSON (e.g. caller passed a BigInt).
 */
export function writeOauthAccount(oauthAccount: Record<string, unknown>): void {
  const existing = readGlobalConfig() ?? {}
  const next: ClaudeGlobalConfig = { ...existing, oauthAccount }
  writeGlobalConfigAtomic(next)
}

/**
 * Remove the `oauthAccount` key from the config, preserving sibling keys.
 * No-op when the file does not exist or has no `oauthAccount` key.
 */
export function clearOauthAccount(): void {
  const existing = readGlobalConfig()
  if (existing === null) return
  if (!('oauthAccount' in existing)) return
  const { oauthAccount, ...rest } = existing
  void oauthAccount
  writeGlobalConfigAtomic(rest)
}
