/**
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §4 (machineActivity).
 *
 * Tests for `resolveCallerSession` and `isUnknownSession`. Both are pure
 * helpers — no Convex runtime needed — so we exercise them directly
 * without convex-test.
 *
 * Branches under test for `resolveCallerSession`:
 *   1. identity.sid is a non-empty string → returned (FAPI precedence)
 *   2. identity.sid is empty string → falls through to argSid
 *   3. identity.sid is non-string (undefined / number / object) → falls through
 *   4. argSid non-empty → returned (when sid missing)
 *   5. both missing/empty → returns UNKNOWN_SESSION_SENTINEL
 *   6. both present → identity.sid wins (FAPI precedence)
 */
import type { UserIdentity } from 'convex/server'
import { describe, expect, it } from 'vitest'

import { UNKNOWN_SESSION_SENTINEL, coalesceMachineId, isUnknownSession, resolveCallerSession } from './identity'

/**
 * Build a `UserIdentity`-shaped object with optional `sid`. The real type
 * doesn't include `sid` because Convex's `UserIdentity` is the spec'd
 * subset; Clerk's FAPI tokens add `sid` opportunistically (see
 * docs/research/clerk-convex-tanstack-integration.md) so we extend the
 * shape locally.
 */
function makeIdentity(sid?: unknown): UserIdentity {
  return {
    subject: 'user_test',
    issuer: 'https://clerk.test',
    tokenIdentifier: 'https://clerk.test|user_test',
    ...(sid !== undefined ? { sid } : {}),
  } as UserIdentity
}

describe('resolveCallerSession', () => {
  it('returns identity.sid when it is a non-empty string (FAPI origin)', () => {
    const identity = makeIdentity('sess_fapi_abc123')
    expect(resolveCallerSession(identity)).toBe('sess_fapi_abc123')
  })

  it('falls through to argSid when identity.sid is an empty string', () => {
    const identity = makeIdentity('')
    expect(resolveCallerSession(identity, 'sess_arg_xyz')).toBe('sess_arg_xyz')
  })

  it('falls through to argSid when identity.sid is undefined', () => {
    const identity = makeIdentity(undefined)
    expect(resolveCallerSession(identity, 'sess_arg_xyz')).toBe('sess_arg_xyz')
  })

  it('falls through to argSid when identity.sid is a number (non-string)', () => {
    const identity = makeIdentity(42)
    expect(resolveCallerSession(identity, 'sess_arg_xyz')).toBe('sess_arg_xyz')
  })

  it('falls through to argSid when identity.sid is an object (non-string)', () => {
    const identity = makeIdentity({ id: 'sess_obj' })
    expect(resolveCallerSession(identity, 'sess_arg_xyz')).toBe('sess_arg_xyz')
  })

  it('returns argSid when identity.sid is missing and argSid is non-empty', () => {
    const identity = makeIdentity()
    expect(resolveCallerSession(identity, 'sess_cli_only')).toBe('sess_cli_only')
  })

  it('returns the sentinel when both identity.sid and argSid are missing', () => {
    const identity = makeIdentity()
    expect(resolveCallerSession(identity)).toBe(UNKNOWN_SESSION_SENTINEL)
  })

  it('returns the sentinel when both identity.sid and argSid are empty strings', () => {
    const identity = makeIdentity('')
    expect(resolveCallerSession(identity, '')).toBe(UNKNOWN_SESSION_SENTINEL)
  })

  it('prefers identity.sid over argSid when both are present (FAPI precedence)', () => {
    const identity = makeIdentity('sess_from_fapi')
    expect(resolveCallerSession(identity, 'sess_from_arg')).toBe('sess_from_fapi')
  })
})

describe('coalesceMachineId', () => {
  it('prefers a real machineId when present (current CLI writes)', () => {
    expect(coalesceMachineId({ machineId: 'machine-uuid', clerkSessionId: 'sess_legacy' })).toBe('machine-uuid')
  })

  it('falls back to clerkSessionId for legacy rows with no machineId', () => {
    expect(coalesceMachineId({ clerkSessionId: 'sess_legacy' })).toBe('sess_legacy')
  })

  it('falls back to the sentinel when neither field is set (cron / server rows)', () => {
    expect(coalesceMachineId({})).toBe(UNKNOWN_SESSION_SENTINEL)
  })
})

describe('isUnknownSession', () => {
  it('matches the canonical sentinel', () => {
    expect(isUnknownSession(UNKNOWN_SESSION_SENTINEL)).toBe(true)
    expect(isUnknownSession('unknown-session')).toBe(true)
  })

  it('matches case-insensitive variants (defensive against drift)', () => {
    expect(isUnknownSession('UNKNOWN-SESSION')).toBe(true)
    expect(isUnknownSession('Unknown-Session')).toBe(true)
  })

  it('matches whitespace-padded variants', () => {
    expect(isUnknownSession(' Unknown-Session ')).toBe(true)
    expect(isUnknownSession('  unknown-session\n')).toBe(true)
  })

  it('rejects real Clerk session ids', () => {
    expect(isUnknownSession('sess_abc123')).toBe(false)
    expect(isUnknownSession('sess_2QQQQQQQQQQQQQQ')).toBe(false)
  })

  it('treats empty string as not-the-sentinel (it is a different anomaly)', () => {
    // Empty string is structurally distinct: it usually means a bug
    // wrote a blank session id. Filter at the call site, not here.
    expect(isUnknownSession('')).toBe(false)
  })

  it('treats undefined and null as unknown (defensive default)', () => {
    expect(isUnknownSession(undefined)).toBe(true)
    expect(isUnknownSession(null)).toBe(true)
  })
})
