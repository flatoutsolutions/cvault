import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { decrypt, encrypt } from './crypto'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  // Use a deterministic 32-byte key for tests so failures are reproducible.
  // Real prod key is set via `npx convex env set VAULT_AES_KEY`.
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 7).toString('base64')
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.VAULT_AES_KEY
  } else {
    process.env.VAULT_AES_KEY = ORIGINAL_KEY
  }
})

describe('AES-256-GCM crypto envelope', () => {
  const samplePlaintext = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-EXAMPLE-TOKEN',
      refreshToken: 'sk-ant-ort01-EXAMPLE-REFRESH',
      expiresAt: 1700000000000,
      scopes: ['user:inference'],
    },
  })

  it('roundtrips plaintext through encrypt + decrypt', () => {
    const { ciphertext, nonce } = encrypt(samplePlaintext)
    const recovered = decrypt(ciphertext, nonce)

    expect(recovered).toBe(samplePlaintext)
  })

  it('returns a 12-byte nonce per encryption', () => {
    const { nonce } = encrypt(samplePlaintext)

    expect(nonce.byteLength).toBe(12)
  })

  it('uses a fresh nonce on every encrypt() call', () => {
    const a = encrypt(samplePlaintext)
    const b = encrypt(samplePlaintext)

    const aBytes = Buffer.from(a.nonce)
    const bBytes = Buffer.from(b.nonce)

    expect(aBytes.equals(bBytes)).toBe(false)
  })

  it('throws when the ciphertext has been tampered with', () => {
    const { ciphertext, nonce } = encrypt(samplePlaintext)

    const tampered = new Uint8Array(ciphertext)
    // Flip one bit somewhere in the middle of the cipher to invalidate the auth tag.
    tampered[Math.floor(tampered.length / 2)] ^= 0x01

    expect(() => decrypt(tampered.buffer, nonce)).toThrow()
  })

  it('throws when the nonce has been tampered with', () => {
    const { ciphertext, nonce } = encrypt(samplePlaintext)

    const tamperedNonce = new Uint8Array(nonce)
    tamperedNonce[0] ^= 0x01

    expect(() => decrypt(ciphertext, tamperedNonce.buffer)).toThrow()
  })

  it('throws when the master key is missing', () => {
    delete process.env.VAULT_AES_KEY

    expect(() => encrypt(samplePlaintext)).toThrow(/VAULT_AES_KEY/)
  })

  it('throws when the master key is not 32 bytes after base64 decode', () => {
    process.env.VAULT_AES_KEY = Buffer.alloc(16, 1).toString('base64')

    expect(() => encrypt(samplePlaintext)).toThrow(/32 bytes/)
  })
})
