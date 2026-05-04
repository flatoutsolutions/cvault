/**
 * Pure functions for building and parsing cvault backup bundles.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
 */
import { describe, expect, it } from 'vitest'

import { type BackupAccount, buildBundle, parseBundle, validateBundle } from './bundle'

const sampleAccount: BackupAccount = {
  email: 'a@example.com',
  slot: 1,
  subscriptionType: 'max',
  rateLimitTier: 'tier1',
  expiresAt: 12345,
  ciphertext: 'YWJj',
  nonce: 'ZGVm',
}

describe('buildBundle', () => {
  it('emits the expected shape', () => {
    const bundle = buildBundle({
      saltBase64: 'c2FsdA==',
      accounts: [sampleAccount],
      now: 999,
    })
    expect(bundle.version).toBe(1)
    expect(bundle.kind).toBe('cvault-backup')
    expect(bundle.exportedAt).toBe(999)
    expect(bundle.kdf.name).toBe('scrypt')
    expect(bundle.kdf.salt).toBe('c2FsdA==')
    expect(bundle.accounts).toHaveLength(1)
  })
})

describe('parseBundle / validateBundle', () => {
  it('round-trips a valid bundle', () => {
    const original = buildBundle({ saltBase64: 'c2FsdA==', accounts: [sampleAccount], now: 1 })
    const json = JSON.stringify(original)
    expect(parseBundle(json)).toEqual(original)
  })

  it('rejects unknown version', () => {
    const bundle = buildBundle({ saltBase64: 's', accounts: [], now: 1 })
    const tampered = { ...bundle, version: 99 }
    expect(() => validateBundle(tampered)).toThrow(/version/)
  })

  it('rejects missing kind', () => {
    const bundle = buildBundle({ saltBase64: 's', accounts: [], now: 1 })
    const broken: unknown = { ...bundle, kind: undefined }
    expect(() => validateBundle(broken)).toThrow(/kind/)
  })

  it('rejects unknown kdf name', () => {
    const bundle = buildBundle({ saltBase64: 's', accounts: [], now: 1 })
    const broken = { ...bundle, kdf: { ...bundle.kdf, name: 'pbkdf2' } }
    expect(() => validateBundle(broken)).toThrow(/scrypt/)
  })

  it('rejects malformed account shape', () => {
    const bundle = buildBundle({ saltBase64: 's', accounts: [], now: 1 })
    const broken = { ...bundle, accounts: [{ email: 'a' }] }
    expect(() => validateBundle(broken)).toThrow(/account/)
  })
})
