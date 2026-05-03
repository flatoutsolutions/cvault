/**
 * Cross-process file lock for the active credentials write cycle.
 *
 * Why we need this: `applyEnvelope` and `clearActive` both perform a
 * read-modify-write on `~/.claude.json` and the credentials store. If
 * two `cvault` processes run concurrently (`cvault switch` from one
 * shell, `cvault add` from another, or a misclick on a dashboard
 * "Force Refresh" while a CLI op is in flight), they can interleave the
 * two writes and corrupt the merged state.
 *
 * Design:
 *  - The lock is a sentinel file at `<lockPath>` created via
 *    `fs.openSync(path, 'wx')` ("create exclusive"). If the file
 *    already exists, openSync throws `EEXIST` immediately. **This is
 *    the actual mutex** — `openSync(...,'wx')` is an atomic POSIX
 *    `O_CREAT|O_EXCL|O_WRONLY` syscall. Two processes racing to acquire
 *    will see exactly one win + one EEXIST.
 *  - On `EEXIST`, we sleep with exponential backoff and retry up to
 *    `timeoutMs`. After that we treat the lock as stale and break it
 *    only when its mtime is past a fixed wall-clock threshold
 *    (`STALE_LOCK_AGE_MS`).
 *  - Stale-lock detection is layered: (1) wall-clock age check,
 *    (2) pid liveness probe via `process.kill(pid, 0)` if the lock file
 *    contains a parseable pid. Linux/Mac `process.kill(pid, 0)` returns
 *    silently for live processes and throws `ESRCH` for dead ones; we
 *    treat ESRCH as "definitely safe to break."
 *  - The held duration must be short — we wrap a single read +
 *    Keychain write + JSON merge, all of which complete in < 50ms on a
 *    healthy box.
 *
 * Why not `proper-lockfile` (the npm package): adding a runtime dep is
 * undesirable (cvault prides itself on zero external deps). The
 * exclusive-create primitive is built into node:fs and gives the same
 * mutual-exclusion guarantee for the small surface we need.
 *
 * Lock path convention: `<config_home>/.cvault.lock`. Living next to
 * `~/.claude.json` keeps the lock in the same filesystem so `rename`
 * and `unlink` are atomic with the data file.
 *
 * TOCTOU note: between the staleness check (`statSync` + optional
 * `process.kill(pid, 0)`) and the `unlinkSync` that follows, another
 * contender could in theory race us. Two contenders both observe the
 * stale lock, both unlink it, both try to re-open. That's safe — the
 * race resolves at the `openSync('wx')` syscall, which is atomic at the
 * kernel level: exactly one wins, the other gets EEXIST and loops
 * again. We never read the lock-file CONTENTS to make a decision (the
 * pid in there is debug info, not state), so concurrent breakers
 * cannot corrupt anything.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { getClaudeConfigHome } from './paths'

const LOCK_FILENAME = '.cvault.lock'

/** Default time to wait for a contended lock before giving up. */
const DEFAULT_TIMEOUT_MS = 5_000

/** Default initial backoff between retries. */
const INITIAL_BACKOFF_MS = 25

/**
 * Maximum backoff cap (ms) — keeps wait times bounded even if the
 * timeout is generous. Prevents a slow contender from waiting many
 * seconds between probes.
 */
const MAX_BACKOFF_MS = 250

/**
 * Wall-clock age (ms) above which a held lock is presumed dead. A
 * healthy `cvault` op completes in tens of milliseconds; 60s gives
 * generous headroom for a slow Convex round-trip and still identifies
 * a crashed prior holder unambiguously.
 *
 * Networked filesystems (Dropbox, iCloud Drive) can have unreliable
 * mtime granularity; for those the pid-liveness probe (below) is the
 * primary signal.
 */
const STALE_LOCK_AGE_MS = 60_000

/** Path to the cvault credentials lock file. */
export function getLockPath(): string {
  return join(getClaudeConfigHome(), LOCK_FILENAME)
}

/** Sleep helper using setTimeout. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface ErrnoLike {
  code?: string
}
function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as ErrnoLike).code === 'EEXIST'
}

/**
 * Read the holder's pid out of a lock file. Returns undefined when the
 * file is unreadable or its contents don't match the stamp format.
 * Best effort — used only as a hint for liveness checking, not for
 * mutex correctness.
 */
function readLockPid(lockPath: string): number | undefined {
  try {
    const content = readFileSync(lockPath, 'utf8')
    const match = /pid=(\d+)\s/.exec(content)
    if (!match || match[1] === undefined) return undefined
    const pid = Number.parseInt(match[1], 10)
    return Number.isNaN(pid) ? undefined : pid
  } catch {
    return undefined
  }
}

/**
 * Returns true if the OS reports `pid` as alive (or we can't tell).
 * `process.kill(pid, 0)` on POSIX:
 *   - returns silently when the process exists (any signal 0 means
 *     "check-only, don't actually signal")
 *   - throws ESRCH when the process is gone
 *   - throws EPERM when the process exists but we lack signal rights
 *     (still alive — answer is "yes, alive")
 *
 * On Windows, signal 0 is unreliable; we conservatively return true so
 * we don't break a lock based on an unreliable probe. Native v1
 * doesn't support Windows anyway.
 */
function isProcessAlive(pid: number): boolean {
  if (process.platform === 'win32') return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    const code = (err as ErrnoLike).code
    if (code === 'ESRCH') return false
    // EPERM and others = alive but un-signalable, or unknown — assume alive.
    return true
  }
}

/**
 * Acquire `lockPath` exclusively, then run `fn`, then release the lock.
 *
 * Order of operations:
 *  1. Try `openSync(lockPath, 'wx')`. Success → we hold the lock.
 *  2. EEXIST → check staleness:
 *     a. If the lock file's mtime is past `STALE_LOCK_AGE_MS`, break it.
 *     b. Else if the lock contains a pid that `process.kill(pid, 0)`
 *        reports as dead, break it.
 *     c. Otherwise sleep with backoff and retry.
 *  3. If `timeoutMs` elapses without success, throw.
 *  4. After `fn` resolves (or throws), unlink the lock in `finally`.
 *
 * The lock file's contents are the holder's pid + start time, used
 * for the liveness probe in 2b (and useful for debugging "who has the
 * lock?"). They are never required for correctness.
 */
export async function withFileLock<T>(
  fn: () => Promise<T> | T,
  opts: { lockPath?: string; timeoutMs?: number } = {}
): Promise<T> {
  const lockPath = opts.lockPath ?? getLockPath()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Ensure the parent dir exists. Claude Code may not have run yet.
  mkdirSync(dirname(lockPath), { recursive: true })

  const start = Date.now()
  let backoff = INITIAL_BACKOFF_MS
  let fd: number | undefined

  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    } catch (err: unknown) {
      if (!isEexist(err)) throw err

      // Check for staleness on every retry — not just on timeout. A
      // crashed prior holder leaves a lock file we can break early
      // rather than making the contender sit through the full timeout.
      // Staleness is measured against a fixed bound (`STALE_LOCK_AGE_MS`)
      // independent of the contender's `timeoutMs` so a slow but
      // healthy holder isn't preemptively evicted by an impatient peer.
      if (existsSync(lockPath)) {
        let breakLock = false
        try {
          const stats = statSync(lockPath)
          const ageMs = Date.now() - stats.mtimeMs
          if (ageMs > STALE_LOCK_AGE_MS) {
            breakLock = true
          } else {
            // mtime says "fresh" — but on networked filesystems the
            // mtime can lag. Fall back to a pid liveness probe.
            const pid = readLockPid(lockPath)
            if (pid !== undefined && pid !== process.pid && !isProcessAlive(pid)) {
              breakLock = true
            }
          }
        } catch {
          // Lock disappeared between exists + stat — race with another
          // process releasing. Try again immediately.
          continue
        }
        if (breakLock) {
          try {
            unlinkSync(lockPath)
          } catch {
            // Another contender beat us to the unlink — fine, retry.
          }
          continue
        }
      }

      const elapsed = Date.now() - start
      if (elapsed >= timeoutMs) {
        throw new Error(
          `Could not acquire credentials lock at ${lockPath} within ${timeoutMs.toString()}ms. ` +
            `Another cvault process may be running. If you are sure no other ` +
            `process holds it, delete the lock file and retry.`
        )
      }
      await sleep(Math.min(backoff, MAX_BACKOFF_MS))
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    }
  }

  try {
    // Stamp the lock with our pid for debuggability AND for the
    // liveness probe above. Best-effort: a write failure here doesn't
    // compromise correctness.
    try {
      writeSync(fd, `pid=${process.pid.toString()} startedAt=${new Date().toISOString()}\n`)
    } catch {
      // ignore
    }
    return await fn()
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
    try {
      unlinkSync(lockPath)
    } catch {
      // ignore — another process may have broken our lock as stale
    }
  }
}
