/**
 * Linux/WSL plaintext credentials store at `<config_home>/.credentials.json`.
 *
 * On Linux/WSL, Claude Code persists OAuth tokens to a plain file rather
 * than a Keychain, so cvault must do the same. The file mirrors the
 * Keychain blob shape on macOS — i.e. the verbatim JSON
 * `{ claudeAiOauth: { ... } }`.
 *
 * Atomic writes use the temp-rename pattern from `claude-swap`'s
 * `_write_credentials`:
 *   1. Write to `<path>.<pid>.tmp` with 0600
 *   2. `rename` over `<path>` (POSIX atomic on the same fs)
 *   3. chmod 0600 on the final file (belt + suspenders)
 *
 * This guarantees a reader (Claude Code itself) never sees a half-written
 * file. The temp file's inode is reused on rename, so we don't leak.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { getCredentialsFilePath } from './paths'

const FILE_MODE = 0o600

/**
 * Read the credentials file. Returns `null` when the file is absent
 * (matches Keychain's exit-44 → null on macOS for symmetry).
 */
export function readCredentialsFile(): string | null {
  const path = getCredentialsFilePath()
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

/**
 * Write the credentials blob atomically with mode 0600.
 *
 * Creates the parent directory if missing — Claude Code may not have run
 * yet on a fresh machine, so `<config_home>` may not exist. mkdir is
 * recursive + idempotent.
 */
export function writeCredentialsFile(blob: string): void {
  const path = getCredentialsFilePath()
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })

  const tmpPath = `${path}.${process.pid.toString()}.tmp`
  try {
    writeFileSync(tmpPath, blob, { mode: FILE_MODE, encoding: 'utf8' })
    // `writeFileSync`'s mode arg only takes effect when the file is
    // created. If a stale tmp was left behind from a crashed prior run,
    // the perms might be wrong. Force them BEFORE the rename — POSIX
    // `rename(2)` preserves the source inode's metadata atomically, so
    // a single chmod on the tmp file is enough. (L4e: dropped the
    // redundant post-rename chmod.)
    if (process.platform !== 'win32') {
      chmodSync(tmpPath, FILE_MODE)
    }
    renameSync(tmpPath, path)
  } finally {
    // Defensive cleanup. If `rename` succeeded the tmp is gone; if it
    // failed and the tmp exists, remove it so we don't leak.
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // ignore — we did our best
      }
    }
  }
}

/** Remove the credentials file. No-op when already absent. */
export function deleteCredentialsFile(): void {
  const path = getCredentialsFilePath()
  if (!existsSync(path)) return
  unlinkSync(path)
}
