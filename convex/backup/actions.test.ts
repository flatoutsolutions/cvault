/**
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { seedSubscription } from '../__scenarios__/_helpers.scenario'
import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import { __setAnthropicFetch } from '../subscriptions/anthropic'
import { parseBundle } from './bundle'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 89).toString('base64')
  // Anthropic stub for any incidental calls (e.g. fetchUsageForSub
  // scheduled by upsertFromPlaintext if it ran).
  __setAnthropicFetch((() => Promise.resolve(new Response('rate-limited', { status: 429 }))) as typeof fetch)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  __setAnthropicFetch(undefined)
  if (ORIGINAL_KEY === undefined) delete process.env.VAULT_AES_KEY
  else process.env.VAULT_AES_KEY = ORIGINAL_KEY
})

describe('exportEncryptedBackup', () => {
  it('returns a base64 bundle that parses cleanly', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'a@example.com', expiresAt: 1 })
    const result = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    expect(result.filename).toMatch(/^cvault-backup-\d{4}-\d{2}-\d{2}\.cvb$/)
    const json = Buffer.from(result.contentBase64, 'base64').toString('utf8')
    const bundle = parseBundle(json)
    expect(bundle.accounts).toHaveLength(1)
    expect(bundle.accounts[0]?.email).toBe('a@example.com')
  })

  it('rejects passphrase < 12 chars', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'a@example.com', expiresAt: 1 })
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
        passphrase: 'short',
      })
    ).rejects.toThrow(/12/)
  })

  it("inserts a machineActivity row with action='export' (audit)", async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'a@example.com', expiresAt: 1 })
    await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    const rows = await t.run(async (ctx) => await ctx.db.query('machineActivity').collect())
    expect(rows.some((r) => r.action === 'export')).toBe(true)
  })

  it('owner-scoped: bundle excludes other users subs', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'mine@example.com', expiresAt: 1 })
    // Seed a sub for a different identity. The export under TEST_IDENTITY
    // must NOT include it.
    const other = { subject: 'user_other', issuer: 'i', tokenIdentifier: 'i|user_other', name: 'O', email: 'o@e.com' }
    await seedSubscription({ t, identity: other, email: 'theirs@example.com', expiresAt: 1 })

    const result = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    const json = Buffer.from(result.contentBase64, 'base64').toString('utf8')
    const bundle = parseBundle(json)
    expect(bundle.accounts).toHaveLength(1)
    expect(bundle.accounts[0]?.email).toBe('mine@example.com')
  })
})
