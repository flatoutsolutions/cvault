/**
 * Unit tests for the version-aware crypto loader.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §4.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { currentKeyVersion, decrypt, encrypt } from './crypto'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY
const ORIGINAL_PREVIOUS = process.env.VAULT_AES_KEY_PREVIOUS
const ORIGINAL_VERSION = process.env.VAULT_KEY_VERSION

beforeEach(() => {
  // Distinct fill bytes from other test files to keep parallel runs clean.
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 41).toString('base64')
  delete process.env.VAULT_AES_KEY_PREVIOUS
  delete process.env.VAULT_KEY_VERSION
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.VAULT_AES_KEY
  else process.env.VAULT_AES_KEY = ORIGINAL_KEY
  if (ORIGINAL_PREVIOUS === undefined) delete process.env.VAULT_AES_KEY_PREVIOUS
  else process.env.VAULT_AES_KEY_PREVIOUS = ORIGINAL_PREVIOUS
  if (ORIGINAL_VERSION === undefined) delete process.env.VAULT_KEY_VERSION
  else process.env.VAULT_KEY_VERSION = ORIGINAL_VERSION
})

describe('currentKeyVersion', () => {
  it('returns "v1" by default', () => {
    expect(currentKeyVersion()).toBe('v1')
  })

  it('returns VAULT_KEY_VERSION when set', () => {
    process.env.VAULT_KEY_VERSION = 'v2'
    expect(currentKeyVersion()).toBe('v2')
  })
})

describe('encrypt/decrypt with versioning', () => {
  it('encrypt returns the current key version label', () => {
    const result = encrypt('hello world')
    expect(result.keyVersion).toBe('v1')
  })

  it('encrypt returns "v2" label when VAULT_KEY_VERSION=v2', () => {
    process.env.VAULT_KEY_VERSION = 'v2'
    const result = encrypt('hello world')
    expect(result.keyVersion).toBe('v2')
  })

  it('decrypt round-trips when keyVersion matches current', () => {
    const { ciphertext, nonce, keyVersion } = encrypt('hello world')
    expect(decrypt(ciphertext, nonce, keyVersion)).toBe('hello world')
  })

  it('decrypt round-trips a row whose keyVersion matches PREVIOUS', () => {
    // Encrypt under "v1" with the original VAULT_AES_KEY.
    const oldEncrypted = encrypt('original')
    expect(oldEncrypted.keyVersion).toBe('v1')

    // Rotate: old key → PREVIOUS, new key → current, version → v2.
    process.env.VAULT_AES_KEY_PREVIOUS = process.env.VAULT_AES_KEY
    process.env.VAULT_AES_KEY = Buffer.alloc(32, 53).toString('base64')
    process.env.VAULT_KEY_VERSION = 'v2'

    // The old row's keyVersion is still "v1" — decrypt must look up PREVIOUS.
    expect(decrypt(oldEncrypted.ciphertext, oldEncrypted.nonce, oldEncrypted.keyVersion)).toBe('original')
  })

  it('decrypt treats undefined keyVersion as v1 (legacy rows)', () => {
    const { ciphertext, nonce } = encrypt('legacy')
    // Legacy row written before keyVersion field existed → undefined.
    expect(decrypt(ciphertext, nonce, undefined)).toBe('legacy')
  })

  it('decrypt throws when row keyVersion matches neither current nor previous', () => {
    const { ciphertext, nonce } = encrypt('lost')
    // Caller asks for a version we have no key for.
    expect(() => decrypt(ciphertext, nonce, 'v99')).toThrow(/No master key/)
  })
})
