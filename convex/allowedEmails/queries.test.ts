import { describe, expect, it } from 'vitest'

import { vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { BOOTSTRAP_ALLOWED_EMAILS } from '../utils/domainGate'

describe('allowedEmails.queries', () => {
  describe('list (public)', () => {
    it('returns empty array when table empty', async () => {
      const t = vault()
      const rows = await t.query(api.allowedEmails.queries.list, {})
      expect(rows).toEqual([])
    })

    it('returns rows in email-asc order', async () => {
      const t = vault()
      await t.run(async (ctx) => {
        await ctx.db.insert('allowedEmails', { email: 'zeta@example.com', addedAtMs: 100 })
        await ctx.db.insert('allowedEmails', { email: 'alice@example.com', addedAtMs: 200 })
      })
      const rows = await t.query(api.allowedEmails.queries.list, {})
      expect(rows.map((r) => r.email)).toEqual(['alice@example.com', 'zeta@example.com'])
    })

    it('does not require auth', async () => {
      const t = vault()
      const rows = await t.query(api.allowedEmails.queries.list, {})
      expect(Array.isArray(rows)).toBe(true)
    })
  })

  describe('loadInternal', () => {
    it('returns BOOTSTRAP when table empty', async () => {
      const t = vault()
      const rows = await t.query(internal.allowedEmails.queries.loadInternal, {})
      expect(rows).toEqual([...BOOTSTRAP_ALLOWED_EMAILS])
    })

    it('returns lowercased emails when non-empty', async () => {
      const t = vault()
      await t.run(async (ctx) => {
        await ctx.db.insert('allowedEmails', { email: 'Samuel.Asseg@Gmail.Com', addedAtMs: 1 })
      })
      const rows = await t.query(internal.allowedEmails.queries.loadInternal, {})
      expect(rows).toEqual(['samuel.asseg@gmail.com'])
    })
  })
})
