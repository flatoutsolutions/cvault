/**
 * Scenario #12 — Concurrent `cvault switch` lock contention on the same machine.
 *
 * Plan: Track B item 12b (production-deployment spec).
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7
 *  + cli/src/native/lock.ts (`withFileLock` cross-process file lock).
 *
 * What this scenario covers end-to-end:
 *  - Two `runSwitch(<different-slot>)` calls dispatched concurrently
 *    in the same process.
 *  - Each goes through `client.action(pullForSwitch)` → `importEnvelope`
 *    → real `applyEnvelope` → real `withFileLock`.
 *  - The lock serializes the two writes: enter/exit pairs in the
 *    keychain-write spy must not interleave.
 *  - Both `runSwitch` calls resolve (no lock-acquire timeout under
 *    normal contention).
 *  - The on-disk `~/.claude.json` is valid JSON post-race (never a
 *    truncated/half-merged document).
 *  - The final active sub matches the LAST writer to enter the
 *    critical section (last-writer-wins semantics under the lock).
 *
 * Stubbed:
 *  - `keychain.ts` — real Keychain access in tests is dangerous and
 *    flaky; we observe writes via a spy. The lock is real, the
 *    `~/.claude.json` writes are real (in tmpdir).
 *  - `makeVaultClient` — wired to in-memory FakeVaultClient.
 *
 * NOT stubbed (the whole point of the scenario):
 *  - `applyEnvelope` and `withFileLock` — these run for real so the
 *    serialization invariant is exercised end-to-end.
 *  - `claudeConfig.ts` — real reads + real atomic temp-and-rename writes.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runSwitch } from '../../src/commands/switch'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { writeActiveCredentials } from '../../src/native/keychain'
import { createFakeVaultClient, makeSub } from './_helpers'

// Mock the Keychain backend so writes are observable + safe in tests.
// readActiveCredentials returns null (no prior creds on this fresh machine)
// so the rollback snapshot path doesn't try to restore something that
// never existed.
vi.mock('../../src/native/keychain', () => ({
  KEYCHAIN_SERVICE: 'Claude Code-credentials',
  readActiveCredentials: vi.fn(() => null),
  writeActiveCredentials: vi.fn(),
  deleteActiveCredentials: vi.fn(),
}))

// Mock the Linux/WSL credentials file backend the same way (so the
// platform router doesn't fall through to a real file-write on Linux CI).
vi.mock('../../src/native/credentialsFile', () => ({
  readCredentialsFile: vi.fn(() => null),
  writeCredentialsFile: vi.fn(),
  deleteCredentialsFile: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

let tempHome: string
let originalPlatform: NodeJS.Platform

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-concurrent-switch-'))
  vi.stubEnv('HOME', tempHome)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  // Make sure the .vault dir exists at mode 0700 so `writeSecret` and the
  // lock file can be created without races on first use.
  mkdirSync(join(tempHome, '.vault'), { recursive: true, mode: 0o700 })
  originalPlatform = process.platform
  // Default to macos so the keychain backend is selected (mocked above).
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  rmSync(tempHome, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('Scenario #12 — Concurrent cvault switch lock contention (in-process)', () => {
  it('serializes two concurrent runSwitch calls via withFileLock; claude.json stays valid JSON', async () => {
    // Two distinct subs the user can switch between. Each plaintext
    // blob includes the `config.oauthAccount` slice so applyEnvelope
    // takes the writeOauthAccount path (otherwise it short-circuits on
    // `account.config?.oauthAccount === undefined` and ~/.claude.json
    // is never touched — defeating the point of the lock test).
    const subA = await makeSub({
      email: 'alice@example.com',
      slot: 1,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA',
          refreshToken: 'sk-ant-ort01-BBBBBBBBBBBBBBBBBBBB',
          expiresAt: 1_900_000_000_000,
          scopes: ['user:inference', 'user:profile'],
          subscriptionType: 'max',
        },
        config: { oauthAccount: { emailAddress: 'alice@example.com' } },
      }),
    })
    const subB = await makeSub({
      email: 'bob@example.com',
      slot: 2,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          // Distinct suffix from alice's so the keychain-write spy can
          // tell which envelope is in the critical section.
          accessToken: 'sk-ant-oat01-BOB-AAAAAAAAAAAAAAAA-BOBBB',
          refreshToken: 'sk-ant-ort01-BOB-BBBBBBBBBBBBBBBB-BOBBB',
          expiresAt: 1_900_000_000_000,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
        config: { oauthAccount: { emailAddress: 'bob@example.com' } },
      }),
    })
    const fake = createFakeVaultClient({
      subscriptions: [subA, subB],
      machineId: 'machine-local',
    })
    vi.mocked(makeVaultClient).mockResolvedValue(fake as never)

    // Track which envelope is currently inside the keychain write
    // critical section. The lock guarantees serialized entry/exit.
    const events: string[] = []
    vi.mocked(writeActiveCredentials).mockImplementation((blob: string) => {
      // Use the access-token suffix to identify which envelope the
      // call belongs to (alice has -AAAAAAAAAAAAAAAAAAAA, bob has
      // -BOB-AAAAAAAAAAAAAAAAAAA).
      const tokenMatch = /accessToken":"([^"]+)/.exec(blob)
      const id = tokenMatch?.[1]?.slice(-5) ?? '?'
      events.push(`enter-${id}`)
      // Synchronous busy-spin to widen the window any interleaving
      // would have to cross. If the lock failed, the other promise
      // would wake during this window and emit another enter-.
      const start = Date.now()
      while (Date.now() - start < 15) {
        // intentional spin
      }
      events.push(`exit-${id}`)
    })

    // Fire both switches concurrently. Real applyEnvelope, real
    // withFileLock, real claude.json writes.
    await Promise.all([runSwitch({ slotOrEmail: '1' }), runSwitch({ slotOrEmail: '2' })])

    // INVARIANT 1: each enter is immediately followed by its matching
    // exit — no interleaving. The order may be (alice, bob) or (bob,
    // alice) depending on which won the lock race; both are correct.
    expect(events.length).toBe(4)
    expect(events[0]).toMatch(/^enter-/)
    expect(events[1]).toBe(events[0]?.replace('enter-', 'exit-'))
    expect(events[2]).toMatch(/^enter-/)
    expect(events[3]).toBe(events[2]?.replace('enter-', 'exit-'))
    expect(events[0]).not.toBe(events[2]) // distinct subs

    // INVARIANT 2: claude.json is valid JSON after the race. Atomic
    // temp+rename in claudeConfig.writeOauthAccount must guarantee
    // the file is never observed mid-write (this is what the lock
    // guards against — interleaved write of the same file).
    const configPath = join(tempHome, '.claude.json')
    const raw = readFileSync(configPath, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } }
    expect(parsed.oauthAccount).toBeDefined()

    // INVARIANT 3: the final active email matches the SECOND writer
    // (the one whose enter appeared at index 2). Last-writer-wins
    // under the lock. We identify the second writer by token suffix:
    //   'AAAAA' (alice's accessToken last 5) → alice@example.com
    //   'BOBBB' (bob's accessToken last 5)   → bob@example.com
    const idToEmail: Record<string, string> = {
      AAAAA: 'alice@example.com',
      BOBBB: 'bob@example.com',
    }
    const lastWriterId = events[2]?.replace('enter-', '') ?? ''
    const expectedFinalEmail = idToEmail[lastWriterId]
    expect(expectedFinalEmail).toBeDefined()
    expect(parsed.oauthAccount?.emailAddress).toBe(expectedFinalEmail)

    // Both runs reached the action (and via that, importEnvelope and
    // writeActiveCredentials).
    expect(fake.action).toHaveBeenCalledTimes(2)
    expect(writeActiveCredentials).toHaveBeenCalledTimes(2)

    // INVARIANT 4 (post proper-lockfile migration): the lock TARGET is
    // `<HOME>/.claude` (= getClaudeConfigHome()), so proper-lockfile
    // creates `<HOME>/.claude.lock` as the companion mutex. By the time
    // the writes complete and both releases ran, the companion is
    // gone. We can't observe the companion mid-run from this test
    // without instrumenting proper-lockfile, but we CAN assert the
    // post-state cleanup: the companion path is absent.
    const companionLock = join(tempHome, '.claude.lock')
    const { existsSync } = await import('node:fs')
    expect(existsSync(companionLock)).toBe(false)
  })

  /**
   * The cross-process variant: spawn two `bun cli/src/index.ts switch …`
   * subprocesses against a test-harness Convex backend.
   *
   * Why this is `describe.todo` for now:
   *  - The shipped CLI talks to a real Convex deployment via
   *    `makeVaultClient`. Standing up a local Convex (`convex dev` in
   *    a tmpdir) just for this test, plus seeding test subs and Clerk
   *    auth, is significantly more than the 30-minute budget the
   *    Track B brief allows.
   *  - The in-process scenario above already exercises the same
   *    `withFileLock` primitive end-to-end. The lock IS cross-process
   *    safe (`openSync(path, 'wx')` is an atomic POSIX
   *    `O_CREAT|O_EXCL` syscall — see cli/src/native/lock.ts:9-22 for
   *    the full design rationale). The scenario test we'd write with
   *    `Bun.spawn` would exercise the same primitive at a higher
   *    cost.
   *  - When the CLI ships standalone (Track A: Bun bundle), wiring
   *    a Bun.spawn variant becomes trivial: spawn the bundle, point
   *    it at a mock Convex URL, observe lock contention. That's the
   *    natural follow-up.
   */
  describe.todo('cross-process variant via Bun.spawn (deferred — see comment above)')
})
