/**
 * CVLT-3 — per-machine (session-level) lockout via revokedSessions denylist.
 *
 * Verifies that once a Clerk session id is written to `revokedSessions`, any
 * subsequent call through `authenticatedQuery` carrying that `sid` claim is
 * rejected with DEVICE_REVOKED, while:
 *  - identities with no sid are unaffected
 *  - identities with a non-revoked sid are unaffected
 */
import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'

import { vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'

/** Identity whose email passes the bootstrap domain gate. */
const revokedMachineIdentity = {
  subject: 'user_revoked_machine',
  issuer: 'https://clerk',
  tokenIdentifier: 'https://clerk|user_revoked_machine',
  name: 'Revoked Machine User',
  email: 'user@flatout.solutions',
  sid: 'sess_revoked_abc123',
} as const

const activeMachineIdentity = {
  subject: 'user_active_machine',
  issuer: 'https://clerk',
  tokenIdentifier: 'https://clerk|user_active_machine',
  name: 'Active Machine User',
  email: 'active@flatout.solutions',
  sid: 'sess_active_xyz789',
} as const

const noSidIdentity = {
  subject: 'user_no_sid',
  issuer: 'https://clerk',
  tokenIdentifier: 'https://clerk|user_no_sid',
  name: 'No Sid User',
  email: 'nosid@flatout.solutions',
  // no sid field
} as const

describe('authenticated wrappers — revokedSessions device denylist', () => {
  it('allows a query for an identity with a non-revoked sid', async () => {
    const t = vault()
    const result = await t
      .withIdentity(activeMachineIdentity)
      .query(api.machineActivity.queries.distinctSessionsForUser, {})
    expect(Array.isArray(result)).toBe(true)
  })

  it('allows a query for an identity with no sid (dashboard/cron tokens)', async () => {
    const t = vault()
    const result = await t.withIdentity(noSidIdentity).query(api.machineActivity.queries.distinctSessionsForUser, {})
    expect(Array.isArray(result)).toBe(true)
  })

  it('rejects authenticatedQuery when the identity sid is in revokedSessions', async () => {
    const t = vault()

    // Sanity: passes before revoke.
    await expect(
      t.withIdentity(revokedMachineIdentity).query(api.machineActivity.queries.distinctSessionsForUser, {})
    ).resolves.toBeDefined()

    // Revoke the session.
    await t.mutation(internal.revokedSessions.mutations.revoke, {
      sid: 'sess_revoked_abc123',
      at: Date.now(),
    })

    // Now the same query must be rejected.
    await expect(
      t.withIdentity(revokedMachineIdentity).query(api.machineActivity.queries.distinctSessionsForUser, {})
    ).rejects.toThrow(/revoked/i)
  })

  it('rejected error has DEVICE_REVOKED code', async () => {
    const t = vault()
    await t.mutation(internal.revokedSessions.mutations.revoke, {
      sid: 'sess_revoked_abc123',
      at: Date.now(),
    })

    let thrown: unknown
    try {
      await t.withIdentity(revokedMachineIdentity).query(api.machineActivity.queries.distinctSessionsForUser, {})
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeDefined()
    // In convex-test, ConvexError is re-thrown and its data is accessible.
    // The error message wraps the JSON data object — check via the message string.
    const msg = thrown instanceof Error ? thrown.message : String(thrown)
    expect(msg).toMatch(/DEVICE_REVOKED/i)
  })

  it('does not block an identity with no sid even when unrelated sessions are revoked', async () => {
    const t = vault()
    await t.mutation(internal.revokedSessions.mutations.revoke, {
      sid: 'sess_revoked_abc123',
      at: Date.now(),
    })

    // noSidIdentity has no sid — must not be blocked.
    const result = await t.withIdentity(noSidIdentity).query(api.machineActivity.queries.distinctSessionsForUser, {})
    expect(Array.isArray(result)).toBe(true)
  })

  it('does not block an identity whose sid is different from the revoked one', async () => {
    const t = vault()
    await t.mutation(internal.revokedSessions.mutations.revoke, {
      sid: 'sess_revoked_abc123',
      at: Date.now(),
    })

    // activeMachineIdentity.sid = 'sess_active_xyz789' — not revoked.
    const result = await t
      .withIdentity(activeMachineIdentity)
      .query(api.machineActivity.queries.distinctSessionsForUser, {})
    expect(Array.isArray(result)).toBe(true)
  })
})
