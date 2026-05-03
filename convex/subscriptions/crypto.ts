'use node'

/**
 * AES-256-GCM encryption envelope for subscription credentials.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §6
 *
 * - Master key from `VAULT_AES_KEY` env var (32 bytes, base64-encoded).
 * - Fresh 12-byte nonce per write.
 * - Plaintext is the JSON-stringified `claudeAiOauth` blob.
 * - Auth tag is appended to the ciphertext (Node `node:crypto` GCM API),
 *   so decrypt() will throw on tamper.
 *
 * This file is gated to the Node runtime via `'use node'`. Only Convex
 * actions can import it; queries and mutations must accept already-encrypted
 * ciphertext+nonce as arguments.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const KEY_LENGTH_BYTES = 32
const NONCE_LENGTH_BYTES = 12
const AUTH_TAG_LENGTH_BYTES = 16

function loadMasterKey(): Buffer {
  const raw = process.env.VAULT_AES_KEY
  if (!raw) {
    throw new Error('VAULT_AES_KEY env var is not set; cannot encrypt/decrypt subscription credentials')
  }

  let key: Buffer
  try {
    key = Buffer.from(raw, 'base64')
  } catch {
    throw new Error('VAULT_AES_KEY must be base64-encoded')
  }

  if (key.byteLength !== KEY_LENGTH_BYTES) {
    throw new Error(`VAULT_AES_KEY must decode to exactly 32 bytes (got ${key.byteLength.toString()})`)
  }

  return key
}

export interface EncryptResult {
  /** AES-256-GCM ciphertext concatenated with the 16-byte auth tag. */
  ciphertext: ArrayBuffer
  /** 12-byte nonce / IV; must be persisted and passed back to decrypt(). */
  nonce: ArrayBuffer
}

/**
 * Encrypt a UTF-8 plaintext string using AES-256-GCM with a freshly generated
 * nonce. Returns a ciphertext+tag bundle and the nonce (both ArrayBuffer to
 * match Convex's `v.bytes()` validator).
 */
export function encrypt(plaintext: string): EncryptResult {
  const key = loadMasterKey()
  const nonce = randomBytes(NONCE_LENGTH_BYTES)

  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  // Layout: [ciphertext || authTag]
  const bundle = Buffer.concat([enc, tag])
  return {
    ciphertext: bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength),
    nonce: nonce.buffer.slice(nonce.byteOffset, nonce.byteOffset + nonce.byteLength),
  }
}

/**
 * Decrypt a ciphertext bundle produced by encrypt(). Throws on auth tag
 * mismatch (i.e., tampering).
 */
export function decrypt(ciphertextBundle: ArrayBuffer, nonce: ArrayBuffer): string {
  const key = loadMasterKey()

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
