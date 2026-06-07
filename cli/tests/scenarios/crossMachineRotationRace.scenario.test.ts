/**
 * Scenario #11 — Cross-machine rotation race during `cvault switch`.
 *
 * Plan: Track B item 12a (production-deployment spec).
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5
 *  + §10 (refresh semantics) + §12 (R1 rollback invariant).
 *
 * What this scenario covers end-to-end (regression test for R1):
 *  - Machine A invokes `runSwitch(<email>)` against the vault.
 *  - Concurrently, machine B's cron-driven refresh has bumped the
 *    server's stored ciphertext for that same sub (rotated access
 *    token, new contentHash).
 *  - The action returns the most-recent server state (post-rotation
 *    plaintext + contentHash). Machine A's local `~/.vault/last-hash-*`
 *    cache and the imported envelope must reflect THAT state, not a
 *    stale half-and-half mix.
 *
 * Why this is the R1 regression test at scenario level:
 *  - R1 (`applyEnvelope` rollback) lives in the lock + rollback machinery
 *    inside `cli/src/native/envelope.ts`. The unit-level test for R1 is
 *    in `cli/tests/native/envelope.test.ts`. This scenario asserts the
 *    higher-level invariant: a switch racing a server-side rotation
 *    leaves the local machine matching the most recent server state.
 *
 * Stubbed (and why):
 *  - `importEnvelope` (the native write half) is mocked because its
 *    correctness is covered by the per-module tests; we only need to
 *    observe what envelope was handed to it.
 *  - `makeVaultClient` is wired to the in-memory FakeVaultClient. The
 *    "race" is modeled by mutating the fake's `state.subscriptions`
 *    map between the moment runSwitch starts and the moment it reads.
 */
import { existsSync, readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runSwitch } from '../../src/commands/switch'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { importEnvelope } from '../../src/credentials'
import { lastHashPath } from '../../src/paths'
import {
  SAMPLE_OAUTH_BLOB,
  cleanupTempHome,
  createFakeVaultClient,
  makeSub,
  setupTempHome,
  sha256Hex,
} from './_helpers'

vi.mock('../../src/credentials', () => ({
  importEnvelope: vi.fn(),
  switchTo: vi.fn(),
}))

vi.mock('../../src/convex/vaultClient', () => ({
  makeVaultClient: vi.fn(),
  VaultClient: class {},
}))

let tempHome: string

beforeEach(() => {
  tempHome = setupTempHome('cvault-cross-machine-race-test-')
})

afterEach(() => {
  cleanupTempHome(tempHome)
})

describe('Scenario #11 — Cross-machine rotation race during cvault switch', () => {
  it('local keychain matches the post-rotation server state, not the pre-rotation snapshot', async () => {
    // Pre-rotation server state: machine A is about to call switch on this sub.
    const preRotationBlob = SAMPLE_OAUTH_BLOB
    const sub = await makeSub({
      email: 'race@example.com',
      slot: 1,
      plaintextBlob: preRotationBlob,
    })
    // Snapshot the pre-rotation hash NOW: makeSub stores by reference
    // and the rotation step below mutates `sub.contentHash` in-place.
    const preRotationHash = sub.contentHash
    const fake = createFakeVaultClient({
      subscriptions: [sub],
      machineId: 'machine-A',
    })
    vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)

    // Mid-flight rotation: between makeVaultClient resolving and the
    // pullForSwitch action firing, machine B's cron refresh bumps the
    // ciphertext on the server. Hook into the action mock to mutate
    // state right before the read so the action sees the new blob.
    const postRotationBlob = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-ROTATED-AAAAAAAAAAAAAAA',
        refreshToken: 'sk-ant-ort01-ROTATED-BBBBBBBBBBBBBBB',
        expiresAt: 1_900_000_000_000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    })
    const postRotationHash = await sha256Hex(postRotationBlob)

    // Wrap the action so the first invocation (pullForSwitch) flips the
    // backing row mid-call. The fake's pullForSwitch handler reads
    // `state.subscriptions.get(...)` — mutating the map before the
    // handler runs is enough to simulate machine B winning the race.
    const originalAction = fake.action
    fake.action = vi.fn(async (ref, args) => {
      // Machine B's refresh lands FIRST: rotate the stored row.
      const row = fake.state.subscriptions.get(sub._id as string)
      if (row !== undefined) {
        row.plaintextBlob = postRotationBlob
        row.contentHash = postRotationHash
      }
      return await originalAction(ref, args)
    }) as typeof fake.action

    await runSwitch({ slotOrEmail: 'race@example.com' })

    // INVARIANT: the envelope handed to the keychain importer must
    // carry the post-rotation plaintext, NOT the pre-rotation blob.
    expect(importEnvelope).toHaveBeenCalledOnce()
    const envelope = vi.mocked(importEnvelope).mock.calls[0]?.[0]
    const oauth = envelope?.accounts[0]?.credentials.claudeAiOauth
    expect(oauth?.accessToken).toBe('sk-ant-oat01-ROTATED-AAAAAAAAAAAAAAA')
    expect(oauth?.refreshToken).toBe('sk-ant-ort01-ROTATED-BBBBBBBBBBBBBBB')

    // INVARIANT: the local hash cache reflects the post-rotation state.
    // Half-and-half (e.g. envelope post-rotation but hash file
    // pre-rotation) would mean a future hash-match short-circuit
    // believes nothing changed and skips the next legitimate switch.
    const hashPath = lastHashPath('race@example.com')
    expect(existsSync(hashPath)).toBe(true)
    const localHash = readFileSync(hashPath, 'utf8')
    expect(localHash).toBe(postRotationHash)
    expect(localHash).not.toBe(preRotationHash) // sanity: rotation actually changed it
  })

  // TODO(prod-deploy follow-up): assert that runSwitch short-circuits when
  // local hash == server contentHash. Current implementation in
  // cli/src/commands/switch.ts ALWAYS calls importEnvelope for the active
  // sub regardless of cache match — that's a separate small fix. This test
  // documents the desired no-op behavior; flip to `it` once the impl matches.
  it.todo(
    'importEnvelope is NOT called when the post-rotation hash matches the local cache (no half-and-half on no-op)',
    async () => {
      // Edge case: the rotation's new hash happens to equal what's on
      // disk locally (e.g. the user already pulled this exact rotation
      // via a prior switch). The cache check should short-circuit and
      // we must NOT re-import. Otherwise we burn a Keychain write on a
      // no-op.
      const sub = await makeSub({
        email: 'noop@example.com',
        slot: 2,
        plaintextBlob: SAMPLE_OAUTH_BLOB,
      })
      const fake = createFakeVaultClient({
        subscriptions: [sub],
        machineId: 'machine-A',
      })
      vi.mocked(makeVaultClient).mockResolvedValueOnce(fake as never)

      // Pre-populate the local hash to match the server's current hash.
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      const hashPath = lastHashPath('noop@example.com')
      mkdirSync(dirname(hashPath), { recursive: true, mode: 0o700 })
      writeFileSync(hashPath, sub.contentHash, { mode: 0o600 })

      await runSwitch({ slotOrEmail: 'noop@example.com' })

      expect(importEnvelope).not.toHaveBeenCalled()
      // Hash file unchanged.
      const localHash = readFileSync(hashPath, 'utf8')
      expect(localHash).toBe(sub.contentHash)
    }
  )
})
