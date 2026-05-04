'use node'

/**
 * AES-256-GCM encryption envelope for subscription credentials.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §4.
 *
 * Two-key model:
 *  - VAULT_AES_KEY        — the *current* master key. New writes use it.
 *  - VAULT_AES_KEY_PREVIOUS — optional. Set during a rotation window so
 *    rows written under the previous key can still be read.
 *  - VAULT_KEY_VERSION    — human-readable label for the current key
 *    (default "v1"). Stored on every newly-written row so rotation can
 *    target stale rows by version filter.
 *
 * This file is gated to the Node runtime via `'use node'`. Only Convex
 * actions can import it; queries and mutations must accept already-encrypted
 * ciphertext+nonce as arguments.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const KEY_LENGTH_BYTES = 32
const NONCE_LENGTH_BYTES = 12
const AUTH_TAG_LENGTH_BYTES = 16
const DEFAULT_VERSION = 'v1'

export function currentKeyVersion(): string {
  return process.env.VAULT_KEY_VERSION ?? DEFAULT_VERSION
}

function decodeKey(raw: string, envName: string): Buffer {
  let key: Buffer
  try {
    key = Buffer.from(raw, 'base64')
  } catch {
    throw new Error(`${envName} must be base64-encoded`)
  }
  if (key.byteLength !== KEY_LENGTH_BYTES) {
    throw new Error(`${envName} must decode to exactly 32 bytes (got ${key.byteLength.toString()})`)
  }
  return key
}

function loadKeyForVersion(version: string): Buffer {
  const current = currentKeyVersion()
  if (version === current) {
    const raw = process.env.VAULT_AES_KEY
    if (!raw) {
      throw new Error('VAULT_AES_KEY env var is not set; cannot encrypt/decrypt subscription credentials')
    }
    return decodeKey(raw, 'VAULT_AES_KEY')
  }
  // Different version → must be the rotation-window predecessor.
  const raw = process.env.VAULT_AES_KEY_PREVIOUS
  if (!raw) {
    throw new Error(
      `No master key available for keyVersion=${version} (currentVersion=${current}). ` +
        `Set VAULT_AES_KEY_PREVIOUS to the previous master key and retry.`
    )
  }
  return decodeKey(raw, 'VAULT_AES_KEY_PREVIOUS')
}

function loadCurrentKey(): Buffer {
  return loadKeyForVersion(currentKeyVersion())
}

export interface EncryptResult {
  /** AES-256-GCM ciphertext concatenated with the 16-byte auth tag. */
  ciphertext: ArrayBuffer
  /** 12-byte nonce / IV; must be persisted and passed back to decrypt(). */
  nonce: ArrayBuffer
  /** The keyVersion label this ciphertext was encrypted under. */
  keyVersion: string
}

/**
 * Encrypt a UTF-8 plaintext string using AES-256-GCM with a freshly generated
 * nonce. Returns a ciphertext+tag bundle, the nonce, and the keyVersion
 * label so the caller can persist all three.
 */
export function encrypt(plaintext: string): EncryptResult {
  const key = loadCurrentKey()
  const nonce = randomBytes(NONCE_LENGTH_BYTES)

  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  // Layout: [ciphertext || authTag]
  const bundle = Buffer.concat([enc, tag])
  return {
    ciphertext: bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength),
    nonce: nonce.buffer.slice(nonce.byteOffset, nonce.byteOffset + nonce.byteLength),
    keyVersion: currentKeyVersion(),
  }
}

/**
 * Decrypt a ciphertext bundle produced by encrypt(). `keyVersion` selects
 * which env-var key to use; `undefined` (legacy row) is treated as "v1".
 * Throws on auth tag mismatch (i.e., tampering).
 */
export function decrypt(ciphertextBundle: ArrayBuffer, nonce: ArrayBuffer, keyVersion?: string): string {
  const version = keyVersion ?? DEFAULT_VERSION
  const key = loadKeyForVersion(version)

  const bundle = Buffer.from(ciphertextBundle)
  if (bundle.byteLength < AUTH_TAG_LENGTH_BYTES) {
    throw new Error('ciphertext is too short to contain an AES-GCM auth tag')
  }

  const enc = bundle.subarray(0, bundle.byteLength - AUTH_TAG_LENGTH_BYTES)
  const tag = bundle.subarray(bundle.byteLength - AUTH_TAG_LENGTH_BYTES)
  const nonceBuf = Buffer.from(nonce)

  const decipher = createDecipheriv('aes-256-gcm', key, nonceBuf)
  decipher.setAuthTag(tag)

  const out = Buffer.concat([decipher.update(enc), decipher.final()])
  return out.toString('utf8')
}
