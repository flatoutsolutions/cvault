import { describe, expect, it } from 'vitest'

import { vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { BOOTSTRAP_ALLOWED_DOMAINS } from '../utils/domainGate'

describe('allowedDomains.queries', () => {
  describe('list (public)', () => {
    it('returns empty array when table empty', async () => {
      const t = vault()
      const rows = await t.query(api.allowedDomains.queries.list, {})
      expect(rows).toEqual([])
    })

    it('returns rows in domain-asc order', async () => {
      const t = vault()
      await t.run(async (ctx) => {
        await ctx.db.insert('allowedEmailDomains', { domain: 'zeta.io', addedAtMs: 100 })
        await ctx.db.insert('allowedEmailDomains', { domain: 'acme.com', addedAtMs: 200 })
      })
      const rows = await t.query(api.allowedDomains.queries.list, {})
      expect(rows.map((r) => r.domain)).toEqual(['acme.com', 'zeta.io'])
    })

    it('does not require auth', async () => {
      const t = vault()
      const rows = await t.query(api.allowedDomains.queries.list, {})
      expect(Array.isArray(rows)).toBe(true)
    })
  })

  describe('loadInternal', () => {
    it('returns BOOTSTRAP when table empty', async () => {
      const t = vault()
      const rows = await t.query(internal.allowedDomains.queries.loadInternal, {})
      expect(rows).toEqual([...BOOTSTRAP_ALLOWED_DOMAINS])
    })

    it('returns lowercased domains when non-empty', async () => {
      const t = vault()
      await t.run(async (ctx) => {
        await ctx.db.insert('allowedEmailDomains', { domain: 'ACME.com', addedAtMs: 1 })
      })
      const rows = await t.query(internal.allowedDomains.queries.loadInternal, {})
      expect(rows).toEqual(['acme.com'])
    })
  })
})
