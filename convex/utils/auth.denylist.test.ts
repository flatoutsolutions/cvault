/**
 * CVLT-3 — denylist enforcement in authenticated wrappers.
 *
 * Verifies that once a user is banned via `internal.revokedUsers.mutations.ban`,
 * any subsequent call through `authenticatedQuery` / `authenticatedMutation` /
 * `authenticatedAction` is rejected with a USER_REVOKED error — regardless of
 * whether that user's email domain is on the allowlist.
 */
import { describe, expect, it } from 'vitest'

import { api, internal } from '../_generated/api'
import { vault } from '../__tests__/helpers'

/** An identity whose email passes the bootstrap domain gate (flatout.solutions). */
const banIdentity = {
  subject: 'user_ban',
  issuer: 'https://clerk',
  tokenIdentifier: 'https://clerk|user_ban',
  name: 'Ali Banned',
  email: 'ali@flatout.solutions',
} as const

describe('authenticated wrappers — revokedUsers denylist', () => {
  it('allows the query before the user is banned', async () => {
    const t = vault()
    const asUser = t.withIdentity(banIdentity)
    // The query returns an empty array when no machineActivity rows exist —
    // that's fine; we just need it not to throw.
    const result = await asUser.query(api.machineActivity.queries.distinctSessionsForUser, {})
    expect(Array.isArray(result)).toBe(true)
  })

  it('rejects authenticatedQuery after ban', async () => {
    const t = vault()
    const asUser = t.withIdentity(banIdentity)

    // Sanity: passes before ban.
    await expect(asUser.query(api.machineActivity.queries.distinctSessionsForUser, {})).resolves.toBeDefined()

    // Ban the user.
    await t.mutation(internal.revokedUsers.mutations.ban, { externalId: 'user_ban', at: Date.now() })

    // Now the same query must be rejected.
    await expect(asUser.query(api.machineActivity.queries.distinctSessionsForUser, {})).rejects.toThrow(/revoked/i)
  })

  it('rejects authenticatedMutation after ban', async () => {
    const t = vault()
    const asUser = t.withIdentity(banIdentity)

    await t.mutation(internal.revokedUsers.mutations.ban, { externalId: 'user_ban', at: Date.now() })

    // softRemove is an authenticatedMutation. It will throw USER_REVOKED
    // before it even gets to check whether the email exists.
    await expect(asUser.mutation(api.subscriptions.mutations.softRemove, { email: 'any@flatout.solutions' })).rejects.toThrow(
      /revoked/i
    )
  })

  it('rejects authenticatedAction after ban', async () => {
    const t = vault()
    const asUser = t.withIdentity(banIdentity)

    await t.mutation(internal.revokedUsers.mutations.ban, { externalId: 'user_ban', at: Date.now() })

    // pullForSwitch is an authenticatedAction. Rejection happens before
    // any subscription logic runs.
    await expect(
      asUser.action(api.subscriptions.actions.pullForSwitch, { slotOrEmail: 'any@flatout.solutions' })
    ).rejects.toThrow(/revoked/i)
  })

  it('does not block a different user who is not banned', async () => {
    const t = vault()

    // Ban user_ban.
    await t.mutation(internal.revokedUsers.mutations.ban, { externalId: 'user_ban', at: Date.now() })

    // A different user with the same allowed domain must still pass.
    const otherIdentity = {
      subject: 'user_not_banned',
      issuer: 'https://clerk',
      tokenIdentifier: 'https://clerk|user_not_banned',
      name: 'Not Banned',
      email: 'notbanned@flatout.solutions',
    }
    const result = await t
      .withIdentity(otherIdentity)
      .query(api.machineActivity.queries.distinctSessionsForUser, {})
    expect(Array.isArray(result)).toBe(true)
  })
})
