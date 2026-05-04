/**
 * Pure helpers for the cvault backup bundle format.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6
 *
 * Kept pure (no Node-only imports) so it can be unit-tested without
 * spinning up a Convex action runtime.
 *
 * Format v2 hardens v1 with three additions from the 2026-05-04 review:
 *   - C1: AAD on each per-account AES-GCM. The associated data is the
 *     account's `email|slot|exportedAt` triple. Tampering with any of
 *     these wire-format fields makes decryption fail.
 *   - C2: HMAC-SHA256 over the canonical bundle JSON (excluding the mac
 *     field itself). Defends against metadata-only tampering — e.g. an
 *     attacker swapping `kdf.salt` to brute-force a different passphrase
 *     against the same ciphertexts.
 *   - C3: scrypt N bumped from 32768 to 131072 (OWASP 2026 floor).
 */

export interface BackupAccount {
  email: string
  slot: number
  label?: string
  subscriptionType: string
  rateLimitTier: string
  expiresAt: number
  refreshExpiresAt?: number
  /** Base64 of AES-GCM(plaintextBlob, encKey) including auth tag. */
  ciphertext: string
  /** Base64 of 12-byte nonce. */
  nonce: string
}

export interface ScryptKdfParams {
  name: 'scrypt'
  N: number
  r: number
  p: number
  /** Output length in bytes — 64 = 32-byte enc-key concat 32-byte mac-key. */
  keyLen: number
  salt: string
}

export interface CvaultBackupBundle {
  version: 2
  kind: 'cvault-backup'
  exportedAt: number
  kdf: ScryptKdfParams
  /**
   * Base64 HMAC-SHA256 over the canonical JSON of every other field of
   * this bundle (`{version, kind, exportedAt, kdf, accounts}` in that
   * lexicographic order, with accounts in their original order).
   */
  mac: string
  accounts: BackupAccount[]
}

/**
 * scrypt cost parameters. N=131072 matches the OWASP 2026 floor for
 * password storage and is calibrated to ~1-3 seconds on a modern Mac
 * (acceptable for a once-per-restore operation). The point of scrypt
 * over PBKDF2 is memory hardness — even at lower N it defeats GPU
 * brute-force; bumping N raises the wall further.
 *
 * keyLen=64 derives twice as many bytes as a single AES-256 key; the
 * caller splits the result into [encKey, macKey] for AES-GCM + HMAC.
 */
export const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1, keyLen: 64 } as const

/** Derived-key split offsets used by the backup actions. */
export const ENC_KEY_BYTES = 32
export const MAC_KEY_BYTES = 32

export function buildBundleWithoutMac(opts: {
  saltBase64: string
  accounts: BackupAccount[]
  now: number
}): Omit<CvaultBackupBundle, 'mac'> {
  return {
    version: 2,
    kind: 'cvault-backup',
    exportedAt: opts.now,
    kdf: {
      name: 'scrypt',
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      keyLen: SCRYPT_PARAMS.keyLen,
      salt: opts.saltBase64,
    },
    accounts: opts.accounts,
  }
}

/**
 * Canonical serialization for HMAC. Stable key order regardless of how
 * `JSON.stringify` happens to walk the object — protects against the
 * importer accepting a re-ordered bundle that hashes to a different mac.
 *
 * Keep deterministic: top-level keys in fixed lexicographic order
 * (accounts, exportedAt, kdf, kind, version), nested objects flattened
 * via `JSON.stringify` (insertion order is fine inside leaves because
 * we control the writer).
 */
export function canonicalSerializeForMac(bundle: Omit<CvaultBackupBundle, 'mac'>): string {
  return JSON.stringify({
    accounts: bundle.accounts,
    exportedAt: bundle.exportedAt,
    kdf: bundle.kdf,
    kind: bundle.kind,
    version: bundle.version,
  })
}

/**
 * Build the AAD bytes for one account's AES-GCM envelope. Bound fields
 * are `email|slot|exportedAt` joined by U+001F (ASCII unit separator)
 * so any single-field tamper changes the AAD and the decrypt's auth
 * tag check fails.
 */
export function accountAadBytes(opts: { email: string; slot: number; exportedAt: number }): Buffer {
  return Buffer.from(`${opts.email}${opts.slot.toString()}${opts.exportedAt.toString()}`, 'utf8')
}

export function parseBundle(json: string): CvaultBackupBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Backup file is malformed JSON.')
  }
  return validateBundle(parsed)
}

function isString(x: unknown): x is string {
  return typeof x === 'string'
}
function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

export function validateBundle(parsed: unknown): CvaultBackupBundle {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Backup is not an object.')
  }
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 2) {
    throw new Error(`Unsupported backup version: ${String(obj.version)}.`)
  }
  if (obj.kind !== 'cvault-backup') {
    throw new Error('Backup kind is missing or wrong.')
  }
  if (!isNumber(obj.exportedAt)) {
    throw new Error('Backup exportedAt is missing or invalid.')
  }
  if (!isString(obj.mac)) {
    throw new Error('Backup mac is missing.')
  }
  const kdf = obj.kdf as Record<string, unknown> | undefined
  if (
    !kdf ||
    kdf.name !== 'scrypt' ||
    !isNumber(kdf.N) ||
    !isNumber(kdf.r) ||
    !isNumber(kdf.p) ||
    !isNumber(kdf.keyLen) ||
    !isString(kdf.salt)
  ) {
    throw new Error('Backup kdf is missing or not scrypt.')
  }
  if (!Array.isArray(obj.accounts)) {
    throw new Error('Backup accounts is not an array.')
  }
  const accounts: BackupAccount[] = obj.accounts.map((raw, idx) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Backup account ${String(idx)} is not an object.`)
    }
    const a = raw as Record<string, unknown>
    if (
      !isString(a.email) ||
      !isNumber(a.slot) ||
      !isString(a.subscriptionType) ||
      !isString(a.rateLimitTier) ||
      !isNumber(a.expiresAt) ||
      !isString(a.ciphertext) ||
      !isString(a.nonce)
    ) {
      throw new Error(`Backup account ${String(idx)} is malformed (missing required fields).`)
    }
    const account: BackupAccount = {
      email: a.email,
      slot: a.slot,
      subscriptionType: a.subscriptionType,
      rateLimitTier: a.rateLimitTier,
      expiresAt: a.expiresAt,
      ciphertext: a.ciphertext,
      nonce: a.nonce,
    }
    if (isString(a.label)) account.label = a.label
    if (isNumber(a.refreshExpiresAt)) account.refreshExpiresAt = a.refreshExpiresAt
    return account
  })
  return {
    version: 2,
    kind: 'cvault-backup',
    exportedAt: obj.exportedAt,
    kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, keyLen: kdf.keyLen, salt: kdf.salt },
    mac: obj.mac,
    accounts,
  }
}
