/**
 * Cross-process file lock tests.
 *
 * Tests use a tmpdir + a lockPath under that dir so we don't touch the
 * real `~/.claude/.cvault.lock`. Single-process concurrency tests run
 * two `withFileLock` promises in the same process. The cross-process
 * test (L4a-2) spawns a real second `bun` process that holds the lock
 * while we try to acquire it from the test process — proving the
 * mutex actually works across process boundaries.
 */
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { withFileLock } from '../../src/native/lock'

let tempDir: string
let lockPath: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cvault-lock-test-'))
  vi.stubEnv('HOME', tempDir)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  lockPath = join(tempDir, '.cvault.lock')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('withFileLock', () => {
  it('runs the body when no contention, releasing the lock afterwards', async () => {
    const result = await withFileLock(() => 'done', { lockPath })
    expect(result).toBe('done')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('serializes two concurrent acquirers (one waits for the other)', async () => {
    const order: string[] = []
    const a = withFileLock(
      async () => {
        order.push('a-start')
        await new Promise((r) => setTimeout(r, 30))
        order.push('a-end')
      },
      { lockPath, timeoutMs: 2_000 }
    )
    const b = withFileLock(
      async () => {
        order.push('b-start')
        await new Promise((r) => setTimeout(r, 5))
        order.push('b-end')
      },
      { lockPath, timeoutMs: 2_000 }
    )

    await Promise.all([a, b])

    // Whichever started first must end before the other starts. The
    // critical invariant is mutual exclusion: 'start' for one process
    // must immediately precede its own 'end' with no interleaving.
    const aStartIdx = order.indexOf('a-start')
    const aEndIdx = order.indexOf('a-end')
    const bStartIdx = order.indexOf('b-start')
    const bEndIdx = order.indexOf('b-end')

    if (aStartIdx < bStartIdx) {
      expect(aEndIdx).toBeLessThan(bStartIdx)
    } else {
      expect(bEndIdx).toBeLessThan(aStartIdx)
    }
    expect(existsSync(lockPath)).toBe(false)
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
    expect(existsSync(lockPath)).toBe(false)
  })

  it('breaks a stale lock whose mtime is older than the timeout', async () => {
    // Seed an "old" lock file with an mtime ~10 minutes in the past.
    writeFileSync(lockPath, 'pid=99999 startedAt=2020-01-01T00:00:00.000Z\n', { mode: 0o600 })
    const past = new Date(Date.now() - 600_000)
    utimesSync(lockPath, past, past)

    const result = await withFileLock(() => 'recovered', { lockPath, timeoutMs: 100 })
    expect(result).toBe('recovered')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('throws when contention exceeds timeout AND the lock is fresh', async () => {
    // Hold the lock for longer than the timeout in a separate promise.
    const holder = withFileLock(
      async () => {
        await new Promise((r) => setTimeout(r, 250))
      },
      { lockPath, timeoutMs: 5_000 }
    )

    // Give the holder a moment to actually acquire.
    await new Promise((r) => setTimeout(r, 20))

    await expect(withFileLock(() => 'should-not-run', { lockPath, timeoutMs: 50 })).rejects.toThrow(/lock|acquire/i)

    await holder
  })

  it('L4a: breaks a fresh-mtime lock whose pid no longer exists (process.kill ESRCH)', async () => {
    // Seed a lock file with a fresh mtime but a pid that doesn't exist.
    // The wall-clock staleness check would say "still fresh, wait" —
    // but the pid probe says "no live process holding this," so we
    // can break it immediately.
    writeFileSync(lockPath, 'pid=999999 startedAt=2026-05-02T00:00:00.000Z\n', { mode: 0o600 })
    // Don't backdate mtime — this proves the pid probe is the signal.

    const result = await withFileLock(() => 'recovered', { lockPath, timeoutMs: 100 })
    expect(result).toBe('recovered')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('L4a: does NOT break a fresh-mtime lock whose pid IS alive', async () => {
    // The current process is alive — use our own pid in the lock to
    // simulate "another live cvault holds it." The current-process
    // pid skip in lock.ts (only checks pid !== process.pid) avoids
    // self-eviction; for this test we use a guaranteed-alive pid that
    // is NOT us. PID 1 (init / launchd) is guaranteed alive on
    // POSIX systems.
    writeFileSync(lockPath, 'pid=1 startedAt=2026-05-02T00:00:00.000Z\n', { mode: 0o600 })
    // Fresh mtime: don't backdate.

    await expect(withFileLock(() => 'should-not-run', { lockPath, timeoutMs: 100 })).rejects.toThrow(/lock|acquire/i)

    // Lock file still present (we did not break it).
    expect(existsSync(lockPath)).toBe(true)
  })
})

describe('cross-process lock (L4a-2)', () => {
  it('blocks the test process while a real second `bun` process holds the lock', async () => {
    // Spawn a second bun process that:
    //   1. Acquires the lock via withFileLock
    //   2. Holds it for 400ms
    //   3. Releases
    // Meanwhile the test process tries to acquire the same lock with a
    // 2000ms timeout. Mutual exclusion is verified by the test's
    // acquisition completing AFTER the holder releases.
    const holderScript = `
      import { withFileLock } from '${join(process.cwd(), 'src/native/lock.ts')}'
      await withFileLock(async () => {
        // Signal to parent that we hold the lock by writing a marker.
        const fs = await import('node:fs')
        fs.writeFileSync('${join(tempDir, 'holder-acquired.marker')}', 'ok')
        await new Promise((r) => setTimeout(r, 400))
      }, { lockPath: '${lockPath}', timeoutMs: 2000 })
    `
    const proc = Bun.spawn({
      cmd: ['bun', '-e', holderScript],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    // Wait for the holder to actually acquire (busy-loop with short
    // sleeps; bounded so we don't hang the test on a holder failure).
    const markerPath = join(tempDir, 'holder-acquired.marker')
    const waitStart = Date.now()
    while (!existsSync(markerPath)) {
      if (Date.now() - waitStart > 2000) {
        proc.kill()
        throw new Error('holder process never acquired the lock')
      }
      await new Promise((r) => setTimeout(r, 10))
    }

    // Holder has the lock. Try to acquire from the test process; should
    // wait until the holder releases (~400ms total minus marker-wait).
    const myAcquireStart = Date.now()
    let myWaitedMs = 0
    await withFileLock(
      () => {
        myWaitedMs = Date.now() - myAcquireStart
      },
      { lockPath, timeoutMs: 5_000 }
    )

    // We must have waited at least some non-trivial time for the
    // holder to release. Allow a generous lower bound (50ms) so timing
    // jitter on slow CI doesn't false-fail.
    expect(myWaitedMs).toBeGreaterThanOrEqual(50)

    // Holder process should exit cleanly.
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
  }, 10_000)
})
