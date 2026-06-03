/**
 * Spec: CVLT-3 — devices listForUser query.
 *
 * Verifies:
 *  - listForUser returns an empty array when no devices exist
 *  - listForUser returns the seeded device row with correct fields
 *  - revokedAt is included when set; omitted when not set
 */
import { describe, expect, it } from 'vitest'

import { api, internal } from '../_generated/api'
import { vault, seedUser, TEST_IDENTITY } from '../__tests__/helpers'

describe('devices queries', () => {
  describe('listForUser', () => {
    it('returns an empty array when no devices exist', async () => {
      const t = vault()
      await seedUser(t)
      const asUser = t.withIdentity(TEST_IDENTITY)
      const rows = await asUser.query(api.devices.queries.listForUser, {})
      expect(rows).toEqual([])
    })

    it('returns the device row after upsert', async () => {
      const t = vault()
      const userId = await seedUser(t)
      await t.mutation(internal.devices.mutations.upsert, {
        userId,
        machineId: 'mach-abc',
        label: 'work-laptop',
        at: 1000,
      })
      const asUser = t.withIdentity(TEST_IDENTITY)
      const rows = await asUser.query(api.devices.queries.listForUser, {})
      expect(rows).toHaveLength(1)
      expect(rows[0]?.machineId).toBe('mach-abc')
      expect(rows[0]?.label).toBe('work-laptop')
      expect(rows[0]?.lastSeenAt).toBe(1000)
      expect(rows[0]?.revokedAt).toBeUndefined()
    })

    it('includes revokedAt when the device is revoked', async () => {
      const t = vault()
      const userId = await seedUser(t)
      await t.mutation(internal.devices.mutations.upsert, {
        userId,
        machineId: 'mach-xyz',
        label: 'old-machine',
        at: 1000,
      })
      await t.mutation(internal.devices.mutations.markRevoked, {
        userId,
        machineId: 'mach-xyz',
        at: 9000,
      })
      const asUser = t.withIdentity(TEST_IDENTITY)
      const rows = await asUser.query(api.devices.queries.listForUser, {})
      expect(rows).toHaveLength(1)
      expect(rows[0]?.revokedAt).toBe(9000)
    })
  })
})
