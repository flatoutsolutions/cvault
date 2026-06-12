/**
 * Shared helpers for the native module's `Bun.spawn` call sites.
 */

/**
 * Detect "binary not found" errors raised by `Bun.spawn`.
 *
 * Bun sets `code: 'ENOENT'` on the thrown Error when the executable isn't
 * on PATH, but its *message* is `Executable not found in $PATH: "<bin>"` —
 * which contains neither `'ENOENT'` nor `'No such file'`. So the `code`
 * check is the reliable signal (verified against Bun 1.3.14); the message
 * substring checks are a fallback for other runtimes / error shapes (Node,
 * older Bun) that surface ENOENT only in the message text.
 */
export function isMissingBinaryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if ((err as { code?: unknown }).code === 'ENOENT') return true
  const msg = err.message
  return msg.includes('ENOENT') || msg.includes('No such file')
}
