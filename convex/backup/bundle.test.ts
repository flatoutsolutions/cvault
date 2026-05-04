/**
 * Pure functions for building and parsing cvault backup bundles.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
 */
import { describe, expect, it } from 'vitest'

import {
  type BackupAccount,
  type CvaultBackupBundle,
  accountAadBytes,
  buildBundleWithoutMac,
  canonicalSerializeForMac,
  parseBundle,
  validateBundle,
} from './bundle'

const sampleAccount: BackupAccount = {
  email: 'a@example.com',
  slot: 1,
  subscriptionType: 'max',
  rateLimitTier: 'tier1',
  expiresAt: 12345,
  ciphertext: 'YWJj',
  nonce: 'ZGVm',
}

function withMac(b: ReturnType<typeof buildBundleWithoutMac>, mac = 'AAAAAAAAAAAAAAAAAAAAAA=='): CvaultBackupBundle {
  return { ...b, mac }
}

describe('buildBundleWithoutMac', () => {
  it('emits the v2 shape with kdf.keyLen=64', () => {
    const bundle = buildBundleWithoutMac({
      saltBase64: 'c2FsdA==',
      accounts: [sampleAccount],
      now: 999,
    })
    expect(bundle.version).toBe(2)
    expect(bundle.kind).toBe('cvault-backup')
    expect(bundle.exportedAt).toBe(999)
    expect(bundle.kdf.name).toBe('scrypt')
    expect(bundle.kdf.salt).toBe('c2FsdA==')
    expect(bundle.kdf.keyLen).toBe(64)
    expect(bundle.accounts).toHaveLength(1)
  })
})

describe('canonicalSerializeForMac', () => {
  it('produces stable bytes regardless of source key order', () => {
    const a = buildBundleWithoutMac({ saltBase64: 's', accounts: [sampleAccount], now: 1 })
    const b = {
      version: a.version,
      kind: a.kind,
      kdf: a.kdf,
      exportedAt: a.exportedAt,
      accounts: a.accounts,
    }
    expect(canonicalSerializeForMac(a)).toBe(canonicalSerializeForMac(b))
  })
})

describe('accountAadBytes', () => {
  it('binds email/slot/exportedAt deterministically', () => {
    const aad1 = accountAadBytes({ email: 'a@x', slot: 1, exportedAt: 999 })
    const aad2 = accountAadBytes({ email: 'a@x', slot: 1, exportedAt: 999 })
    expect(aad1.equals(aad2)).toBe(true)
  })
  it('changes when any field changes', () => {
    const base = accountAadBytes({ email: 'a@x', slot: 1, exportedAt: 999 })
    expect(accountAadBytes({ email: 'b@x', slot: 1, exportedAt: 999 }).equals(base)).toBe(false)
    expect(accountAadBytes({ email: 'a@x', slot: 2, exportedAt: 999 }).equals(base)).toBe(false)
    expect(accountAadBytes({ email: 'a@x', slot: 1, exportedAt: 1000 }).equals(base)).toBe(false)
  })
})

describe('parseBundle / validateBundle', () => {
  it('round-trips a valid bundle', () => {
    const original = withMac(buildBundleWithoutMac({ saltBase64: 'c2FsdA==', accounts: [sampleAccount], now: 1 }))
    const json = JSON.stringify(original)
    expect(parseBundle(json)).toEqual(original)
  })

  it('rejects unknown version', () => {
    const bundle = withMac(buildBundleWithoutMac({ saltBase64: 's', accounts: [], now: 1 }))
    const tampered = { ...bundle, version: 99 }
    expect(() => validateBundle(tampered)).toThrow(/version/)
  })

  it('rejects missing kind', () => {
    const bundle = withMac(buildBundleWithoutMac({ saltBase64: 's', accounts: [], now: 1 }))
    const broken: unknown = { ...bundle, kind: undefined }
    expect(() => validateBundle(broken)).toThrow(/kind/)
  })

  it('rejects missing mac', () => {
    const bundle = buildBundleWithoutMac({ saltBase64: 's', accounts: [], now: 1 })
    expect(() => validateBundle(bundle)).toThrow(/mac/)
  })

  it('rejects unknown kdf name', () => {
    const bundle = withMac(buildBundleWithoutMac({ saltBase64: 's', accounts: [], now: 1 }))
    const broken = { ...bundle, kdf: { ...bundle.kdf, name: 'pbkdf2' } }
    expect(() => validateBundle(broken)).toThrow(/scrypt/)
  })

  it('rejects kdf missing keyLen', () => {
    const bundle = withMac(buildBundleWithoutMac({ saltBase64: 's', accounts: [], now: 1 }))
    const { keyLen: _kl, ...kdfMinusKeyLen } = bundle.kdf
    void _kl
    const broken = { ...bundle, kdf: kdfMinusKeyLen }
    expect(() => validateBundle(broken)).toThrow(/scrypt/)
  })

  it('rejects malformed account shape', () => {
    const bundle = withMac(buildBundleWithoutMac({ saltBase64: 's', accounts: [], now: 1 }))
    const broken = { ...bundle, accounts: [{ email: 'a' }] }
    expect(() => validateBundle(broken)).toThrow(/account/)
  })
})
