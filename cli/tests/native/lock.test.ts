/**
 * Cross-process file lock tests.
 *
 * The lock is implemented on top of `proper-lockfile`. Targeting a path
 * with `lockfile.lock(path)` creates a `<path>.lock` directory next to
 * it; release `rmdir`s. We test:
 *
 *   - happy-path acquire + release
 *   - serialization of two concurrent in-process acquirers
 *   - lock release on body throw
 *   - stale-lock recovery (mtime older than the proper-lockfile `stale`
 *     threshold gets reaped on next acquire)
 *   - timeout when contention is fresh and shorter than retry budget
 *   - cross-process mutex via a real second `bun` process
 *
 * Tests use a tmpdir for `lockPath` so they never touch the real
 * `~/.claude.lock`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { withFileLock } from '../../src/native/lock'

let tempDir: string
let lockPath: string
/**
 * Where proper-lockfile actually creates its mutex (a directory at
 * `<lockPath>.lock`). Used by tests to verify acquire/release.
 */
let companionPath: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cvault-lock-test-'))
  vi.stubEnv('HOME', tempDir)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  // proper-lockfile requires the lockTarget to exist (we pass
  // realpath:false but it still does a stat as part of mkdir). Pre-
  // creating a directory at the target keeps the production semantics
  // (locking ~/.claude — a dir) while letting tests use a known path.
  lockPath = join(tempDir, 'lockTarget')
  mkdirSync(lockPath, { recursive: true })
  companionPath = `${lockPath}.lock`
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('withFileLock', () => {
  it('runs the body when no contention, releasing the lock afterwards', async () => {
    const result = await withFileLock(() => 'done', { lockPath })
    expect(result).toBe('done')
    expect(existsSync(companionPath)).toBe(false)
  })

  it('serializes two concurrent acquirers (one waits for the other)', async () => {
    const order: string[] = []
    const a = withFileLock(
      async () => {
        order.push('a-start')
        await new Promise((r) => setTimeout(r, 30))
        order.push('a-end')
      },
      { lockPath, timeoutMs: 4_000 }
    )
    const b = withFileLock(
      async () => {
        order.push('b-start')
        await new Promise((r) => setTimeout(r, 5))
        order.push('b-end')
      },
      { lockPath, timeoutMs: 4_000 }
    )

    await Promise.all([a, b])

    // Whichever started first must end before the other starts. The
    // critical invariant is mutual exclusion: 'start' for one must
    // immediately precede its own 'end' with no interleaving.
    const aStartIdx = order.indexOf('a-start')
    const aEndIdx = order.indexOf('a-end')
    const bStartIdx = order.indexOf('b-start')
    const bEndIdx = order.indexOf('b-end')

    if (aStartIdx < bStartIdx) {
      expect(aEndIdx).toBeLessThan(bStartIdx)
    } else {
      expect(bEndIdx).toBeLessThan(aStartIdx)
    }
    expect(existsSync(companionPath)).toBe(false)
  })

  it('releases the lock even when the body throws', async () => {
    await expect(
      withFileLock(
        () => {
          throw new Error('body failed')
        },
        { lockPath }
      )
    ).rejects.toThrow(/body failed/)
    expect(existsSync(companionPath)).toBe(false)
  })

  it('breaks a stale lock whose mtime is older than the staleness threshold', async () => {
    // Seed a stale companion-lock dir (proper-lockfile uses mkdir for
    // the companion). Backdate its mtime past the stale threshold so a
    // contender treats it as abandoned and reaps it.
    mkdirSync(companionPath)
    const past = new Date(Date.now() - 120_000) // 2 minutes ago > 30s stale
    utimesSync(companionPath, past, past)

    const result = await withFileLock(() => 'recovered', { lockPath, timeoutMs: 4_000 })
    expect(result).toBe('recovered')
    expect(existsSync(companionPath)).toBe(false)
  })

  it('throws when contention exceeds retry budget AND the lock is fresh', async () => {
    // Hold the lock long enough to outlast the contender's retry
    // budget. With `retries: 5, minTimeout: 1000, maxTimeout: 2000`
    // the contender's worst-case wait is ~5×2000ms = 10s. Have the
    // holder run for 12s — definitely longer than the contender's
    // budget. We use fake timers? No — the holder runs in real time so
    // the contender's retry waits trip naturally.
    //
    // Skip the long-running variant in unit tests and just assert
    // failure with a tiny window: pass timeoutMs=0 / minTimeout=0 by
    // pre-acquiring and immediately racing.
    const holder = withFileLock(
      async () => {
        await new Promise((r) => setTimeout(r, 600))
      },
      { lockPath }
    )
    // Give the holder a tick to acquire.
    await new Promise((r) => setTimeout(r, 50))

    // proper-lockfile `retries: 0` → fail immediately on EEXIST. We
    // want to exercise the failure path without the unit test waiting
    // 10 seconds.
    await expect(
      // We pass a tiny timeoutMs which clamps internal min/maxTimeout
      // to the same bound, but proper-lockfile still gets `retries: 5`
      // — at worst we wait ~5×timeoutMs ≈ 50ms here.
      withFileLock(() => 'should-not-run', { lockPath, timeoutMs: 5 })
    ).rejects.toThrow(/lock|locked|acquire/i)

    await holder
  })

  it('the companion lock is a directory while held', async () => {
    let snapshotIsDir = false
    await withFileLock(
      async () => {
        const stat = statSync(companionPath)
        snapshotIsDir = stat.isDirectory()
      },
      { lockPath }
    )
    expect(snapshotIsDir).toBe(true)
    // Released — companion gone.
    expect(existsSync(companionPath)).toBe(false)
  })
})

describe('cross-process lock', () => {
  it('blocks the test process while a real second `bun` process holds the lock', async () => {
    // Spawn a second bun process that:
    //   1. Acquires the lock via withFileLock
    //   2. Holds it for 400ms
    //   3. Releases
    // Meanwhile the test process tries to acquire the same lock with a
    // generous retry envelope. Mutual exclusion is verified by the
    // test's acquisition completing AFTER the holder releases.
    const holderScript = `
      import { withFileLock } from '${join(process.cwd(), 'src/native/lock.ts')}'
      await withFileLock(async () => {
        const fs = await import('node:fs')
        fs.writeFileSync('${join(tempDir, 'holder-acquired.marker')}', 'ok')
        await new Promise((r) => setTimeout(r, 400))
      }, { lockPath: '${lockPath}', timeoutMs: 4_000 })
    `
    const proc = Bun.spawn({
      cmd: ['bun', '-e', holderScript],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const markerPath = join(tempDir, 'holder-acquired.marker')
    const waitStart = Date.now()
    while (!existsSync(markerPath)) {
      if (Date.now() - waitStart > 3000) {
        proc.kill()
        throw new Error('holder process never acquired the lock')
      }
      await new Promise((r) => setTimeout(r, 10))
    }

    const myAcquireStart = Date.now()
    let myWaitedMs = 0
    await withFileLock(
      () => {
        myWaitedMs = Date.now() - myAcquireStart
      },
      { lockPath, timeoutMs: 6_000 }
    )

    expect(myWaitedMs).toBeGreaterThanOrEqual(50)

    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
  }, 15_000)
})
