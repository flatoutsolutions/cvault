/**
 * Pure helpers for the cvault backup bundle format.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
 *
 * Kept pure (no Node-only imports) so it can be unit-tested without
 * spinning up a Convex action runtime.
 */

export interface BackupAccount {
  email: string
  slot: number
  label?: string
  subscriptionType: string
  rateLimitTier: string
  expiresAt: number
  refreshExpiresAt?: number
  /** Base64 of AES-GCM(plaintextBlob, derivedKey) including auth tag. */
  ciphertext: string
  /** Base64 of 12-byte nonce. */
  nonce: string
}

export interface ScryptKdfParams {
  name: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
}

export interface CvaultBackupBundle {
  version: 1
  kind: 'cvault-backup'
  exportedAt: number
  kdf: ScryptKdfParams
  accounts: BackupAccount[]
}

/**
 * scrypt cost parameters. N=32768 is the OWASP 2022 floor; the 2026
 * review (item C3) noted that the modern OWASP floor is 131072.
 * Bumping is a follow-up — flagged in the final report. The point of
 * scrypt vs PBKDF2/Argon2 is memory-hardness regardless of N, so even
 * the conservative N=32768 is well above PBKDF2-equivalent strength.
 */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const

export function buildBundle(opts: { saltBase64: string; accounts: BackupAccount[]; now: number }): CvaultBackupBundle {
  return {
    version: 1,
    kind: 'cvault-backup',
    exportedAt: opts.now,
    kdf: { name: 'scrypt', N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, salt: opts.saltBase64 },
    accounts: opts.accounts,
  }
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
  if (obj.version !== 1) {
    throw new Error(`Unsupported backup version: ${String(obj.version)}.`)
  }
  if (obj.kind !== 'cvault-backup') {
    throw new Error('Backup kind is missing or wrong.')
  }
  if (!isNumber(obj.exportedAt)) {
    throw new Error('Backup exportedAt is missing or invalid.')
  }
  const kdf = obj.kdf as Record<string, unknown> | undefined
  if (
    !kdf ||
    kdf.name !== 'scrypt' ||
    !isNumber(kdf.N) ||
    !isNumber(kdf.r) ||
    !isNumber(kdf.p) ||
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
    version: 1,
    kind: 'cvault-backup',
    exportedAt: obj.exportedAt,
    kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt },
    accounts,
  }
}
