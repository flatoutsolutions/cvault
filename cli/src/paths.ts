/**
 * `~/.vault/` filesystem helpers — directory mode 0700, file mode 0600,
 * atomic writes via temp+rename, and per-file perms checks on read.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §6, §7.
 *
 * All paths are derived from `process.env.HOME` so tests can swap HOME
 * via `vi.stubEnv('HOME', tmp)` without touching the real `~/.vault/`.
 *
 * Platform note: the perms check is only meaningful on POSIX. v1 is
 * Mac-first per spec §2; on Windows we'd need a different perms model
 * (and Windows isn't supported in v1).
 */
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VAULT_DIR_MODE = 0o700
const SECRET_FILE_MODE = 0o600

/**
 * Resolve `~/.vault/`. Re-evaluates `HOME` on each call so tests can stub it.
 */
export function vaultDir(): string {
  const home = process.env.HOME ?? homedir()
  return join(home, '.vault')
}

/** Resolve a file path inside `~/.vault/`. Does NOT create the directory. */
export function vaultFile(name: string): string {
  return join(vaultDir(), name)
}

/**
 * Create `~/.vault/` with mode 0700, tightening perms if it already exists
 * with looser bits. Idempotent.
 */
export async function ensureVaultDir(): Promise<void> {
  const dir = vaultDir()
  await mkdir(dir, { recursive: true, mode: VAULT_DIR_MODE })
  // mkdir's mode arg is masked by umask; chmod is the only way to guarantee 0700.
  await chmod(dir, VAULT_DIR_MODE)
}

/**
 * Write `content` to `path` atomically with mode 0600.
 *
 * Steps:
 *   1. Ensure `~/.vault/` exists with the right perms
 *   2. Write to `<path>.tmp` with 0600
 *   3. Rename `.tmp` over `<path>` (POSIX rename is atomic on the same fs)
 *   4. chmod the final file again as a belt-and-suspenders measure
 */
export async function writeSecret(path: string, content: string): Promise<void> {
  await ensureVaultDir()
  const tmp = `${path}.tmp`
  // `writeFile` honours the mode arg only when creating the file; we follow
  // up with chmod so an existing tmp file (rare — afterEach cleans up) is
  // also tightened.
  await writeFile(tmp, content, { mode: SECRET_FILE_MODE, encoding: 'utf8' })
  await chmod(tmp, SECRET_FILE_MODE)
  await rename(tmp, path)
  await chmod(path, SECRET_FILE_MODE)
  // Defensive: rename should have moved tmp; if for any reason it lingers
  // (network filesystem quirk), unlink it. We don't care about errors here.
  if (existsSync(tmp)) {
    try {
      await unlink(tmp)
    } catch {
      // ignore
    }
  }
}

/**
 * Read a secret file. Returns null if the file does not exist. Throws if the
 * file's perms are world/group readable (defense-in-depth on a creds file).
 *
 * Sync read is fine — secret files are tiny.
 */
export async function readSecret(path: string): Promise<string | null> {
  if (!existsSync(path)) return null
  const stats = await stat(path)
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `${path} has loose permissions (mode ${(stats.mode & 0o777).toString(8)}). ` +
        `Run \`chmod 600 ${path}\` and retry.`
    )
  }
  return readFileSync(path, 'utf8')
}

/**
 * Path of the per-account `last-hash-{email}.txt` file used by
 * `cvault switch` to skip redundant `claude-swap --import -` calls when
 * the local Keychain content is already up to date.
 *
 * Sanitization: replaces `..` with `__` and any `/` or `\` with `_` so a
 * malicious email cannot escape `~/.vault/`. Adjacent unsafe characters
 * collapse: e.g. `../etc/passwd` → `__etc_passwd` (the `../` becomes `__`
 * because the trailing `/` is consumed by the `..` replacement).
 */
export function lastHashPath(email: string): string {
  // Replace `../` and `..\` first, then any remaining `..`, then `/` and `\`.
  // This avoids the double-underscore-then-slash artifact.
  const safe = email
    .replace(/\.\.[/\\]/g, '__')
    .replace(/\.\./g, '__')
    .replace(/[/\\]/g, '_')
  return vaultFile(`last-hash-${safe}.txt`)
}
