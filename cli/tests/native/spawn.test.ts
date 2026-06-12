/**
 * `isMissingBinaryError` — the shared "executable not on PATH" detector
 * used by both `native/brew.ts` and `native/claudeCli.ts` to swap a raw
 * spawn failure for an actionable install hint.
 *
 * The critical case is Bun's real shape: it sets `code: 'ENOENT'` but its
 * message ("Executable not found in $PATH: ...") contains no ENOENT
 * substring, so detection MUST check `err.code`.
 */
import { describe, expect, it } from 'vitest'

import { isMissingBinaryError } from '../../src/native/spawn'

describe('isMissingBinaryError', () => {
  it("matches Bun's real missing-binary error (ENOENT on err.code only)", () => {
    const err = Object.assign(new Error('Executable not found in $PATH: "brew"'), { code: 'ENOENT' })
    expect(isMissingBinaryError(err)).toBe(true)
  })

  it('matches errors whose message contains ENOENT (Node / older runtimes)', () => {
    expect(isMissingBinaryError(new Error('spawn ENOENT'))).toBe(true)
  })

  it('matches errors whose message mentions "No such file"', () => {
    expect(isMissingBinaryError(new Error('No such file or directory'))).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isMissingBinaryError(new Error('permission denied'))).toBe(false)
    expect(isMissingBinaryError(Object.assign(new Error('boom'), { code: 'EACCES' }))).toBe(false)
  })

  it('does not match non-Error values', () => {
    expect(isMissingBinaryError('ENOENT')).toBe(false)
    expect(isMissingBinaryError(null)).toBe(false)
    expect(isMissingBinaryError(undefined)).toBe(false)
  })
})
