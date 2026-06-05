/**
 * Cross-process lock for the active credentials write cycle.
 *
 * Why we need this: `applyEnvelope`, `clearActive`, and the `cvault pull`
 * hook all perform a read-modify-write on `~/.claude.json`
 * + the credentials store (Keychain on macOS, file on Linux/WSL). If
 * two `cvault` processes race — or worse, if `cvault` and Claude Code
 * itself race — they can interleave the two writes and corrupt the
 * merged state.
 *
 * Implementation: `proper-lockfile` against `~/.claude` (the
 * directory). On lock acquisition, proper-lockfile creates
 * `~/.claude.lock` as a directory (mkdir is the atomic POSIX
 * primitive); on release it `rmdir`s. While held, proper-lockfile
 * periodically updates the lock's mtime so a stalled holder is
 * detected by other contenders.
 *
 * Why this lock target: Claude Code (the upstream `claude` binary)
 * uses `proper-lockfile.lock("~/.claude")` for the same read-write
 * cycle. By targeting the same path with the same package, cvault and
 * Claude Code share the SAME lock file (`~/.claude.lock`) and compete
 * fairly for it instead of running blind to each other.
 *
 * The previous implementation hand-rolled the primitive at
 * `~/.claude/.cvault.lock` — correct for cvault-vs-cvault races, but
 * INVISIBLE to Claude Code, which would happily write to
 * `~/.claude.json` while cvault was mid-rotation. Switching to
 * proper-lockfile fixes that gap.
 *
 * API surface compatibility: `withFileLock(fn, opts)` keeps the same
 * signature it had under the custom implementation. `opts.lockPath` is
 * the path being locked (proper-lockfile creates `<lockPath>.lock`
 * next to it). Tests pass an explicit path; production callers omit
 * it and get `getClaudeConfigHome()` (resolves to `$CLAUDE_CONFIG_DIR`
 * or `~/.claude`).
 *
 * Retry policy: 5 retries, 1000-2000ms backoff with jitter. Matches
 * Claude Code's defaults so the two binaries don't bias one over the
 * other under contention.
 */
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import lockfile from 'proper-lockfile'

import { getClaudeConfigHome } from './paths'

/**
 * Path being locked by default. proper-lockfile creates `<this>.lock` —
 * with `~/.claude` as the target, that's `~/.claude.lock`, identical to
 * what Claude Code creates. The two processes thus contend for the same
 * lock file.
 */
export function getLockPath(): string {
  return getClaudeConfigHome()
}

/**
 * Lock-file mtime threshold for staleness. A holder updates the
 * lockfile's mtime every `update` ms; if mtime hasn't moved for
 * `stale` ms, contenders treat it as abandoned and break it.
 *
 * 30s is the proper-lockfile default and is plenty for cvault's tiny
 * critical sections (Keychain write + JSON merge complete in tens of
 * milliseconds).
 */
const STALE_MS = 30_000

/** Update the lockfile's mtime every 5s while held. */
const UPDATE_MS = 5_000

/** Default deadline for acquiring the lock. */
const DEFAULT_TIMEOUT_MS = 5_000

/**
 * Acquire the cvault credentials lock, run `fn`, then release.
 *
 * `fn` may throw — the lock is released in a `finally` either way.
 *
 * Concurrency model:
 *  - proper-lockfile uses `mkdir(<lockPath>.lock)` as the atomic
 *    create-exclusive primitive. Two contenders racing both attempt
 *    `mkdir`; exactly one succeeds, the other gets EEXIST.
 *  - On EEXIST, the contender checks `<lockPath>.lock`'s mtime against
 *    `STALE_MS`. Fresh → wait + retry; stale → `rmdir` and try again.
 *  - The holder updates mtime every `UPDATE_MS` so a healthy lock
 *    looks fresh; a crashed holder's lock will go stale within
 *    `STALE_MS` and be reaped.
 *
 * Why we don't expose a manual stale-lock break: the prior custom lock
 * had a pid-liveness probe via `process.kill(pid, 0)`. proper-lockfile
 * intentionally avoids that path — it works only for same-machine,
 * same-namespace processes, breaks under containers and PID-reuse, and
 * mtime-only staleness covers the realistic crash path. The trade-off
 * is a slightly longer worst-case wait when a contender's process
 * crashed mid-section, but the ceiling is `STALE_MS` (30s) rather than
 * `STALE_LOCK_AGE_MS` (60s) the old code used.
 */
export async function withFileLock<T>(
  fn: () => Promise<T> | T,
  opts: { lockPath?: string; timeoutMs?: number } = {}
): Promise<T> {
  const lockPath = opts.lockPath ?? getLockPath()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // proper-lockfile does NOT mkdir the lock target if it doesn't exist
  // (only the lockfile itself). For the production case the target IS a
  // directory we need to create on a fresh box; for tests the caller's
  // tempdir already exists. Either way, ensure the parent exists too —
  // mkdir(...,{recursive:true}) on an existing dir is a no-op.
  mkdirSync(dirname(lockPath), { recursive: true })

  // N1: explicit branching on what the lock target is. Previously the
  // code did a `try { mkdir } catch { /* ignored */ }` blanket which
  // hid permission errors and other genuine failures behind the same
  // suppressing branch as "already exists". Now we check first:
  //   - exists as a directory → no-op
  //   - exists as a file (legacy `.cvault.lock` sentinel from an
  //     earlier version) → leave alone; proper-lockfile companions a
  //     `<path>.lock` of its own, so the file's presence doesn't break us
  //   - exists as a symlink → we don't follow; proper-lockfile uses
  //     `realpath: false`, so the symlink target isn't relevant. Throw
  //     with a descriptive error so the user (or the umbrella umbrella-repo
  //     symlink shenanigans on dev machines) can investigate.
  //   - does not exist → mkdir it. Permission failures here are
  //     genuine and propagate.
  if (existsSync(lockPath)) {
    const stat = lstatSync(lockPath)
    if (stat.isSymbolicLink()) {
      throw new Error(
        `cvault lock: lock target ${lockPath} is a symlink. ` +
          `Refusing to operate against a symlink — resolve it manually before running cvault.`
      )
    }
    // dir or file: leave it; proper-lockfile manages its own companion
    // `<lockPath>.lock` directory, so the target's type only matters
    // for the fresh-box branch below.
  } else {
    mkdirSync(lockPath, { recursive: true })
  }

  // proper-lockfile's `retries` translates to a node-retry config. We
  // pick numbers that:
  //  - bound the worst case to `timeoutMs` (5 retries × 2s max ≈ 10s
  //    in the absolute pathological case; in practice the operation
  //    fits a 5s timeoutMs because backoff includes jitter)
  //  - match Claude Code's retry envelope per the design brief, so
  //    neither binary starves the other.
  const release = await lockfile.lock(lockPath, {
    realpath: false,
    stale: STALE_MS,
    update: UPDATE_MS,
    retries: {
      retries: 5,
      minTimeout: Math.min(1000, timeoutMs),
      maxTimeout: Math.min(2000, timeoutMs),
      randomize: true,
    },
  })

  try {
    return await fn()
  } finally {
    try {
      await release()
    } catch (err) {
      // The release path is best-effort — proper-lockfile's release
      // can throw `ECOMPROMISED` if the lockfile was reaped by another
      // contender as stale. That's fine: by this point the body has
      // already completed; the contender had no way to actually
      // interleave with our writes (the writes are themselves atomic
      // temp+rename on claude.json + atomic Keychain writes).
      // Log at warn level so real corruption signals stay diagnosable.
      const code = err instanceof Error && 'code' in err ? String(err.code) : 'unknown'
      console.warn(
        `[cvault] proper-lockfile release error (${code}): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}
