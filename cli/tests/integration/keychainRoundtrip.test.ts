/**
 * End-to-end Keychain roundtrip — the only test that touches the real
 * `security` binary.
 *
 * Gated on `CVAULT_E2E_KEYCHAIN=1` because:
 *   - It requires macOS + Keychain access (CI Linux/WSL skips silently).
 *   - It actually writes to the user's login Keychain (under a TEST
 *     service name `cvault-test-credentials`, NOT the production
 *     `Claude Code-credentials`, so it cannot corrupt the user's real
 *     Claude Code credentials).
 *
 * What the test covers:
 *  - Round-trip via the same `security` invocations the production code
 *    uses (stdin-prompt form for write — the S1 hardening) so a real
 *    macOS regression in our spawn args would be caught here.
 *  - Exit-44 from `find` after delete (the "not found" status code we
 *    rely on to short-circuit `read` → null).
 *  - The blob round-trips byte-for-byte (no whitespace mangling, no
 *    extra newlines).
 *
 * Manual run:
 *   CVAULT_E2E_KEYCHAIN=1 bunx --bun vitest run tests/integration/keychainRoundtrip
 *
 * Cleanup is `afterAll` — even on test failure we delete the test entry.
 */
import { afterAll, describe, expect, it } from 'vitest'

const TEST_SERVICE = 'cvault-test-credentials'
const TEST_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'test-access-token-cvault-e2e',
    refreshToken: 'test-refresh-token-cvault-e2e',
    expiresAt: 0,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
})

interface RunOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
}

function runSecurity(args: readonly string[], stdin?: string): RunOutcome {
  const proc = Bun.spawnSync({
    cmd: ['security', ...args],
    stdin: stdin !== undefined ? Buffer.from(stdin, 'utf8') : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  }
}

const runE2E = process.env.CVAULT_E2E_KEYCHAIN === '1' && process.platform === 'darwin'
const guard = runE2E ? describe : describe.skip

guard('Keychain roundtrip (E2E, opt-in)', () => {
  const account = process.env.USER ?? 'user'

  afterAll(() => {
    // Always clean up — even if the test failed mid-write.
    runSecurity(['delete-generic-password', '-a', account, '-s', TEST_SERVICE])
  })

  it('writes via argv `-w <value>`, reads, and deletes a test entry', () => {
    // Ensure clean slate.
    runSecurity(['delete-generic-password', '-a', account, '-s', TEST_SERVICE])

    // Write — using the SAME argv form the production code uses. The
    // stdin-prompt form (`-w` with no value) was investigated for the
    // S1 hardening but truncates at ~128 bytes — Claude Code's OAuth
    // blobs are ~180-250 bytes, so truncation would silently corrupt
    // the credential. See `keychain.ts` write docstring for the
    // full trade-off rationale.
    const writeRes = runSecurity(['add-generic-password', '-U', '-s', TEST_SERVICE, '-a', account, '-w', TEST_BLOB])
    expect(writeRes.exitCode).toBe(0)

    // Read — `-w` emits the password to stdout + exactly one newline.
    const readRes = runSecurity(['find-generic-password', '-a', account, '-s', TEST_SERVICE, '-w'])
    expect(readRes.exitCode).toBe(0)
    // Strip exactly one trailing newline (NOT trim — preserve interior whitespace).
    const got = readRes.stdout.endsWith('\n') ? readRes.stdout.slice(0, -1) : readRes.stdout
    expect(got).toBe(TEST_BLOB)

    // Delete
    const delRes = runSecurity(['delete-generic-password', '-a', account, '-s', TEST_SERVICE])
    expect(delRes.exitCode).toBe(0)

    // Read after delete → exit 44 (errSecItemNotFound)
    const readGone = runSecurity(['find-generic-password', '-a', account, '-s', TEST_SERVICE, '-w'])
    expect(readGone.exitCode).toBe(44)
  })

  it('demonstrates the stdin-prompt truncation that prompted the argv-form choice', () => {
    // Pin the regression: if a future macOS release fixes the 128-byte
    // stdin buffer, this test will fail and we can switch back to the
    // safer stdin-prompt form per S1.
    const longBlob = 'X'.repeat(200)
    runSecurity(['delete-generic-password', '-a', account, '-s', TEST_SERVICE])

    const writeRes = runSecurity(
      ['add-generic-password', '-U', '-s', TEST_SERVICE, '-a', account, '-w'],
      `${longBlob}\n${longBlob}\n`
    )
    expect(writeRes.exitCode).toBe(0)

    const readRes = runSecurity(['find-generic-password', '-a', account, '-s', TEST_SERVICE, '-w'])
    const got = readRes.stdout.endsWith('\n') ? readRes.stdout.slice(0, -1) : readRes.stdout

    // The truncation observed on macOS 26.4 is at 128 bytes; if we ever
    // see a full round-trip we should reopen the S1 conversation.
    expect(got.length).toBeLessThan(longBlob.length)

    runSecurity(['delete-generic-password', '-a', account, '-s', TEST_SERVICE])
  })
})
