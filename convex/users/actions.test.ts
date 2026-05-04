/**
 * Tests for `convex/users/actions.ts`.
 *
 * Currently focused on the `current` query's `returns` validator (audit fix).
 * Without `returns`, a malformed handler return would silently pass through
 * to dashboard callers; with the validator, Convex throws inside
 * `t.query(...)` so we have a guarantee of shape parity with the schema.
 */
import { describe, expect, it } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'

describe('users.actions.current — returns validator', () => {
  it('returns null when caller is not authenticated', async () => {
    const t = vault()
    const result = await t.query(api.users.actions.current, {})
    expect(result).toBeNull()
  })

  it('returns the seeded user row shape that satisfies the declared returns validator', async () => {
    const t = vault()
    const userId = await t.run(async (ctx) => {
      return await ctx.db.insert('users', {
        externalId: TEST_IDENTITY.subject,
        name: TEST_IDENTITY.name,
        primaryEmail: TEST_IDENTITY.email,
        otherEmails: ['alt@flatout.solutions'],
      })
    })

    const result = await t.withIdentity(TEST_IDENTITY).query(api.users.actions.current, {})

    expect(result).not.toBeNull()
    expect(result?._id).toEqual(userId)
    expect(result?.externalId).toBe(TEST_IDENTITY.subject)
    expect(result?.name).toBe(TEST_IDENTITY.name)
    expect(result?.primaryEmail).toBe(TEST_IDENTITY.email)
    expect(result?.otherEmails).toEqual(['alt@flatout.solutions'])
    // _creationTime is required on every Convex row so the validator must
    // declare it; if it's missing the validator would reject the response.
    expect(typeof result?._creationTime).toBe('number')
  })

  it('declares a non-null returns validator (audit fix — was previously absent)', async () => {
    /**
     * The Convex `query` wrapper exposes `exportReturns()`: it returns
     * `JSON.stringify(returnsValidator.json)` when a `returns` validator
     * is declared, or `JSON.stringify(null)` (i.e. literal "null") when
     * none was supplied. This is the deterministic check the audit fix
     * requires: a missing validator silently lets the handler return
     * any shape; with this test, regressing back to "no returns"
     * immediately fails the suite.
     */
    type WithExportReturns = { exportReturns: () => string }
    const mod = await import('./actions')
    const wrapped = mod.current as unknown as WithExportReturns
    expect(typeof wrapped.exportReturns).toBe('function')
    const exported = wrapped.exportReturns()
    // "null" means the wrapper saw no `returns` key — that's the
    // pre-fix state we are explicitly guarding against.
    expect(exported).not.toBe('null')
    // The validator must be a union (user-or-null), so the exported JSON
    // contains a top-level "union" type marker.
    const parsed = JSON.parse(exported) as { type: string }
    expect(parsed.type).toBe('union')
  })
})
