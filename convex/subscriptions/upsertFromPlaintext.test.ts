/**
 * Spec: §5 (`upsert({email, plaintextBlob, slot?})`).
 *
 * `subscriptions.actions.upsertFromPlaintext` is the public surface
 * `cvault add` calls. It encrypts the plaintext blob server-side using
 * VAULT_AES_KEY, then delegates to the internal `upsertEncrypted` mutation.
 *
 * The CLI never holds the master key — only the Convex deployment does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { api } from '../_generated/api'
import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { decrypt } from './crypto'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 13).toString('base64')
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.VAULT_AES_KEY
  } else {
    process.env.VAULT_AES_KEY = ORIGINAL_KEY
  }
})

const SAMPLE_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-FRESH-AAAAAAAAAAAAAAAAAAAAAAAA',
    refreshToken: 'sk-ant-ort01-FRESH-BBBBBBBBBBBBBBBBBBBBBBBB',
    expiresAt: 1700000000000,
    scopes: ['user:inference'],
  },
})

describe('subscriptions.actions.upsertFromPlaintext', () => {
  it('throws when caller is not authenticated', async () => {
    const t = vault()
    await expect(
      t.action(api.subscriptions.actions.upsertFromPlaintext, {
        email: 'a@example.com',
        plaintextBlob: SAMPLE_BLOB,
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      })
    ).rejects.toThrow(/authenticated/i)
  })

  it('encrypts the plaintext and persists it as ciphertext+nonce', async () => {
    const t = vault()
    await seedUser(t)

    const result = await t.withIdentity(TEST_IDENTITY).action(
      api.subscriptions.actions.upsertFromPlaintext,
      {
        email: 'fresh@example.com',
        plaintextBlob: SAMPLE_BLOB,
        expiresAt: Date.now() + 60 * 60 * 1000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      }
    )

    expect(result.created).toBe(true)
    expect(result.slot).toBe(1)

    // Confirm the row was written and decrypts to the original blob.
    const row = await t.run(async (ctx) => await ctx.db.get('subscriptions', result.subId))
    expect(row).not.toBeNull()
    expect(row?.email).toBe('fresh@example.com')
    // The stored ciphertext is NOT the plaintext (defense-in-depth check).
    const ciphertextHex = Buffer.from(row?.ciphertext ?? new ArrayBuffer(0)).toString('hex')
    expect(ciphertextHex).not.toContain(Buffer.from(SAMPLE_BLOB).toString('hex'))

    // Decrypting with the same VAULT_AES_KEY recovers the plaintext.
    const recovered = decrypt(
      row?.ciphertext ?? new ArrayBuffer(0),
      row?.nonce ?? new ArrayBuffer(0)
    )
    expect(recovered).toBe(SAMPLE_BLOB)
  })

  it("inserts a machineActivity row with action='add' on first upsert", async () => {
    const t = vault()
    await seedUser(t)

    const result = await t.withIdentity(TEST_IDENTITY).action(
      api.subscriptions.actions.upsertFromPlaintext,
      {
        email: 'audit-add@example.com',
        plaintextBlob: SAMPLE_BLOB,
        expiresAt: Date.now() + 60 * 60 * 1000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      }
    )

    const rows = await t.run(async (ctx) =>
      await ctx.db.query('machineActivity').collect()
    )
    const addRow = rows.find((r) => r.action === 'add')
    expect(addRow).toBeDefined()
    expect(addRow?.subscriptionId).toEqual(result.subId)
  })

  it('updates an existing sub in place (rotation, not duplicate)', async () => {
    const t = vault()
    await seedUser(t)

    const first = await t.withIdentity(TEST_IDENTITY).action(
      api.subscriptions.actions.upsertFromPlaintext,
      {
        email: 'rotate@example.com',
        plaintextBlob: SAMPLE_BLOB,
        expiresAt: Date.now() + 60 * 60 * 1000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      }
    )
    expect(first.created).toBe(true)

    const newer = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-NEWER-CCCCCCCCCCCCCCCCCCCC',
        refreshToken: 'sk-ant-ort01-NEWER-DDDDDDDDDDDDDDDDDDDD',
        expiresAt: 1800000000000,
      },
    })
    const second = await t.withIdentity(TEST_IDENTITY).action(
      api.subscriptions.actions.upsertFromPlaintext,
      {
        email: 'rotate@example.com',
        plaintextBlob: newer,
        expiresAt: Date.now() + 120 * 60 * 1000,
        subscriptionType: 'max',
        rateLimitTier: 'tier1',
      }
    )
    expect(second.created).toBe(false)
    expect(second.subId).toEqual(first.subId)
    expect(second.slot).toBe(first.slot)

    // Decrypt the latest row -> should be the second blob, not the first.
    const row = await t.run(async (ctx) => await ctx.db.get('subscriptions', second.subId))
    const recovered = decrypt(
      row?.ciphertext ?? new ArrayBuffer(0),
      row?.nonce ?? new ArrayBuffer(0)
    )
    expect(recovered).toBe(newer)
  })
})
