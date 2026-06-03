/**
 * Persistent CLI machine identifier stored in ~/.vault/machine-id.
 *
 * Generated once per machine (random UUIDv4), then read back on every
 * subsequent call. The id is a display/grouping label ONLY — it is never
 * used as an authorization input. Revocation acts on the Clerk OAuth grant
 * and the revokedUsers denylist, not on this value.
 *
 * Spec: docs/superpowers/plans/2026-06-03-cli-oauth-pkce.md §Task 11.
 */
import { randomUUID } from 'node:crypto'
import { readSecret, vaultFile, writeSecret } from '../paths'

/**
 * Path of `~/.vault/machine-id`. Re-evaluates `HOME` per-call so tests
 * can stub it via `vi.stubEnv('HOME', tmp)`.
 */
export function machineIdFilePath(): string {
  return vaultFile('machine-id')
}

/**
 * Read the persistent machine id from `~/.vault/machine-id`, generating
 * and persisting a new random UUID on first use.
 *
 * Thread-safe enough for CLI use: generates a fresh UUID on every process
 * that races on first-write — the last writer wins, both end up with the
 * same file contents, and both reads return that value from then on.
 */
export async function loadOrCreateMachineId(): Promise<string> {
  const existing = await readSecret(machineIdFilePath())
  if (existing !== null && existing.trim().length > 0) return existing.trim()
  const id = randomUUID()
  await writeSecret(machineIdFilePath(), id)
  return id
}
