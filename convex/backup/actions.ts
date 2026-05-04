'use node'

/**
 * Encrypted backup export + import actions.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6
 *
 * Bundle format v2 (the wire shape — see `convex/backup/bundle.ts`) hardens v1 with:
 * - C1: per-account AES-GCM is bound by AAD = `email|slot|exportedAt`. Tampering
 *   with any of those wire fields makes decrypt fail.
 * - C2: HMAC-SHA256 over the canonical bundle JSON (excluding `mac` itself)
 *   defends against metadata-only tampering — e.g. swapping `kdf.salt` to
 *   brute-force a different passphrase against the same ciphertexts.
 * - C3: scrypt N is the OWASP 2026 floor (131072) via `SCRYPT_PARAMS.N`.
 * - C4: derivedKey buffers (which embed both the AES key and the HMAC key)
 *   are zeroed in a `finally` block so a memory dump does not yield the
 *   passphrase-derived material after the action returns.
 *
 * Per the 2026-05-04 review:
 * - A6: every export/import emits a `machineActivity` row.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

import { ConvexError, v } from 'convex/values'

import { internal } from '../_generated/api'
import { decrypt, encrypt } from '../subscriptions/crypto'
import { authenticatedAction, getIdentity } from '../utils/auth'
import { resolveCallerSession } from '../utils/identity'
import {
  type BackupAccount,
  type CvaultBackupBundle,
  ENC_KEY_BYTES,
  MAC_KEY_BYTES,
  SCRYPT_PARAMS,
  accountAadBytes,
  buildBundleWithoutMac,
  canonicalSerializeForMac,
  parseBundle,
} from './bundle'

const MIN_PASSPHRASE_LEN = 12
const SALT_BYTES = 16
const NONCE_BYTES = 12
const SCRYPT_MAX_MEM = 256 * 1024 * 1024

/**
 * Derive a 64-byte buffer from `passphrase` + `saltBuf`. The first 32
 * bytes are the AES-GCM key; the next 32 bytes are the HMAC key.
 *
 * Caller MUST zero the returned buffer with `buf.fill(0)` after use (C4).
 * `finally` blocks in `exportEncryptedBackup` / `importEncryptedBackup`
 * already do this.
 */
function deriveKeys(passphrase: string, saltBuf: Buffer): Buffer {
  return scryptSync(passphrase, saltBuf, ENC_KEY_BYTES + MAC_KEY_BYTES, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAX_MEM,
  })
}

function aesGcmEncrypt(encKey: Buffer, aad: Buffer, plaintext: string): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', encKey, nonce)
  cipher.setAAD(aad)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { ciphertext: Buffer.concat([enc, tag]), nonce }
}

function aesGcmDecrypt(encKey: Buffer, aad: Buffer, bundle: Buffer, nonce: Buffer): string {
  const tag = bundle.subarray(bundle.byteLength - 16)
  const enc = bundle.subarray(0, bundle.byteLength - 16)
  const decipher = createDecipheriv('aes-256-gcm', encKey, nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

function computeMac(macKey: Buffer, canonicalJson: string): Buffer {
  return createHmac('sha256', macKey).update(canonicalJson, 'utf8').digest()
}

/**
 * Per A4 (vault poisoning defense): clamp expiresAt / refreshExpiresAt
 * read out of an untrusted bundle so a tampered bundle can't poison the
 * vault with a `Date.now() + 100yr` value that would forever evade
 * `findExpiringSubs`. Mirrors `ADOPT_MAX_FUTURE_MS` in
 * `convex/subscriptions/mutations.ts`.
 */
const ADOPT_MAX_FUTURE_MS = 24 * 60 * 60 * 1000
function clampExpiresAt(value: number): number {
  const ceiling = Date.now() + ADOPT_MAX_FUTURE_MS
  return value > ceiling ? ceiling : value
}

const exportResultValidator = v.object({
  filename: v.string(),
  contentBase64: v.string(),
  accountCount: v.number(),
})

function todayDateStamp(): string {
  const d = new Date()
  const y = d.getUTCFullYear().toString()
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = d.getUTCDate().toString().padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const exportEncryptedBackup = authenticatedAction({
  args: {
    passphrase: v.string(),
    /**
     * Explicit Clerk session id forwarded by the CLI. BAPI-minted JWTs
     * lack the `sid` claim, so the server prefers `identity.sid` (FAPI)
     * and falls back to this arg via `resolveCallerSession`.
     */
    clerkSessionId: v.optional(v.string()),
    machineLabel: v.optional(v.string()),
  },
  returns: exportResultValidator,
  handler: async (
    ctx,
    { passphrase, clerkSessionId, machineLabel }
  ): Promise<{ filename: string; contentBase64: string; accountCount: number }> => {
    if (passphrase.length < MIN_PASSPHRASE_LEN) {
      throw new ConvexError({
        code: 'BACKUP_PASSPHRASE_TOO_SHORT',
        message: `Passphrase must be at least ${MIN_PASSPHRASE_LEN.toString()} characters.`,
      })
    }

    const identity = getIdentity(ctx)
    const userId = await ctx.runQuery(internal.users.actions.getIdByExternalId, {
      externalId: identity.subject,
    })
    if (!userId) {
      throw new ConvexError({
        code: 'USER_NOT_FOUND',
        message: 'No user row for caller. Sign in once to trigger the Clerk webhook, then retry.',
      })
    }

    // Vault-wide export: per shared-vault doctrine
    // (`convex/utils/users.ts:3-7`) the bundle holds every active sub in
    // the vault, not just the caller's. The bundle is gated by the
    // user's chosen passphrase + the server-side master key, but once
    // exported it carries every co-tenant's encrypted rows.
    const subs = await ctx.runQuery(internal.subscriptions.internalReads.listAllActiveSubsRaw, {})

    const salt = randomBytes(SALT_BYTES)
    const derivedKeys = deriveKeys(passphrase, salt)
    try {
      const encKey = derivedKeys.subarray(0, ENC_KEY_BYTES)
      const macKey = derivedKeys.subarray(ENC_KEY_BYTES, ENC_KEY_BYTES + MAC_KEY_BYTES)

      // Snapshot `now` once so the AAD that binds each account matches
      // the bundle's top-level `exportedAt` field.
      const exportedAt = Date.now()

      const accounts: BackupAccount[] = []
      for (const sub of subs) {
        const plaintext = decrypt(sub.ciphertext, sub.nonce, sub.keyVersion)
        const aad = accountAadBytes({ email: sub.email, slot: sub.slot, exportedAt })
        const { ciphertext, nonce } = aesGcmEncrypt(encKey, aad, plaintext)
        const account: BackupAccount = {
          email: sub.email,
          slot: sub.slot,
          subscriptionType: sub.subscriptionType,
          rateLimitTier: sub.rateLimitTier,
          expiresAt: sub.expiresAt,
          ciphertext: ciphertext.toString('base64'),
          nonce: nonce.toString('base64'),
        }
        if (sub.label !== undefined) account.label = sub.label
        if (sub.refreshExpiresAt !== undefined) account.refreshExpiresAt = sub.refreshExpiresAt
        accounts.push(account)
      }

      const unsigned = buildBundleWithoutMac({
        saltBase64: salt.toString('base64'),
        accounts,
        now: exportedAt,
      })
      const canonical = canonicalSerializeForMac(unsigned)
      const mac = computeMac(macKey, canonical).toString('base64')
      const bundle: CvaultBackupBundle = { ...unsigned, mac }
      const contentBase64 = Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64')

      // A6: audit row. No subscriptionId — this is a bulk operation.
      await ctx.runMutation(internal.machineActivity.mutations.record, {
        userId,
        clerkSessionId: resolveCallerSession(identity, clerkSessionId),
        action: 'export',
        at: Date.now(),
        ...(machineLabel !== undefined ? { machineLabel } : {}),
      })

      return {
        filename: `cvault-backup-${todayDateStamp()}.cvb`,
        contentBase64,
        accountCount: accounts.length,
      }
    } finally {
      // C4: zero the passphrase-derived material so a process-memory dump
      // after this action returns can't recover the AES + HMAC keys.
      derivedKeys.fill(0)
      salt.fill(0)
    }
  },
})

// ---------------------------------------------------------------------------
// importEncryptedBackup
// ---------------------------------------------------------------------------

const importResultValidator = v.object({
  restoredCount: v.number(),
  skippedCount: v.number(),
  errors: v.array(v.string()),
})

export const importEncryptedBackup = authenticatedAction({
  args: {
    passphrase: v.string(),
    bundleBase64: v.string(),
    /**
     * Explicit Clerk session id forwarded by the CLI; see exportEncryptedBackup
     * for the rationale. Resolved via `resolveCallerSession`.
     */
    clerkSessionId: v.optional(v.string()),
    machineLabel: v.optional(v.string()),
  },
  returns: importResultValidator,
  handler: async (
    ctx,
    { passphrase, bundleBase64, clerkSessionId, machineLabel }
  ): Promise<{ restoredCount: number; skippedCount: number; errors: string[] }> => {
    const identity = getIdentity(ctx)
    const userId = await ctx.runQuery(internal.users.actions.getIdByExternalId, {
      externalId: identity.subject,
    })
    if (!userId) {
      throw new ConvexError({
        code: 'USER_NOT_FOUND',
        message: 'No user row for caller. Sign in once to trigger the Clerk webhook, then retry.',
      })
    }

    // Parse + validate the bundle shape FIRST. A malformed bundle should
    // never trigger a partial restore.
    const json = Buffer.from(bundleBase64, 'base64').toString('utf8')
    const bundle = parseBundle(json)
    const salt = Buffer.from(bundle.kdf.salt, 'base64')
    const derivedKeys = deriveKeys(passphrase, salt)
    try {
      const encKey = derivedKeys.subarray(0, ENC_KEY_BYTES)
      const macKey = derivedKeys.subarray(ENC_KEY_BYTES, ENC_KEY_BYTES + MAC_KEY_BYTES)

      // C2: verify HMAC over the canonical bundle bytes BEFORE touching
      // any account-level ciphertext. A bad passphrase produces a wrong
      // macKey and the comparison fails before we attempt any AES decrypt.
      // A tampered metadata field (e.g. swapped salt) ALSO fails here.
      const { mac, ...rest } = bundle
      const expectedMac = computeMac(macKey, canonicalSerializeForMac(rest))
      const providedMac = Buffer.from(mac, 'base64')
      const macsMatch = providedMac.byteLength === expectedMac.byteLength && timingSafeEqual(providedMac, expectedMac)
      if (!macsMatch) {
        throw new ConvexError({
          code: 'BACKUP_BAD_PASSPHRASE',
          message: 'Bad passphrase or tampered bundle — MAC verification failed.',
        })
      }

      // A3 (refuse-overwrite): reject the import upfront if any of the
      // bundle's emails already have a LIVE sub anywhere in the vault.
      // Under shared-vault doctrine the collision check is vault-wide
      // because ANY co-tenant's row would be silently replaced/parallel-
      // inserted on import — `upsertSub` dedupes by (userId, email) so a
      // cross-tenant collision wouldn't actually overwrite, but it would
      // create a duplicate row for the same email that the dashboard
      // would render twice. Either disaster mode is bad enough to refuse
      // the import upfront and force the user to soft-remove the
      // colliding row first.
      const existingLive = await ctx.runQuery(internal.subscriptions.internalReads.listAllActiveSubsRaw, {})
      const liveEmails = new Set(existingLive.map((s) => s.email.toLowerCase()))
      const collisions = bundle.accounts.map((a) => a.email.toLowerCase()).filter((e) => liveEmails.has(e))
      if (collisions.length > 0) {
        throw new ConvexError({
          code: 'BACKUP_WOULD_OVERWRITE',
          message:
            `Restore would overwrite live subscriptions for: ${collisions.join(', ')}. ` +
            `Soft-remove them first or restore into a different account.`,
        })
      }

      // A5 (validate-all-then-commit-all): decrypt every account in pass 1.
      // If ANY account fails to decrypt under the supplied passphrase OR
      // its bound AAD doesn't match the wire-format (email|slot|exportedAt),
      // throw BACKUP_BAD_PASSPHRASE without touching the DB. Only after all
      // plaintexts are recovered does pass 2 re-encrypt + persist.
      const plaintexts: string[] = []
      for (const account of bundle.accounts) {
        try {
          const acctCipher = Buffer.from(account.ciphertext, 'base64')
          const acctNonce = Buffer.from(account.nonce, 'base64')
          const aad = accountAadBytes({
            email: account.email,
            slot: account.slot,
            exportedAt: bundle.exportedAt,
          })
          plaintexts.push(aesGcmDecrypt(encKey, aad, acctCipher, acctNonce))
        } catch {
          // AES-GCM auth tag failure → bad passphrase OR tampered bundle.
          // Surface a single clear error rather than a per-account list.
          throw new ConvexError({
            code: 'BACKUP_BAD_PASSPHRASE',
            message: 'Bad passphrase or tampered bundle — decryption failed.',
          })
        }
      }

      // Pass 2: re-encrypt each plaintext under the server's current master
      // key + persist. We DON'T pass the bundle's `slot` to upsertEncrypted —
      // the mutation allocates fresh slots from `nextFreeSlotForUser` (A4:
      // we don't trust slot values from an untrusted bundle).
      let restoredCount = 0
      const skippedCount = 0
      const errors: string[] = []
      for (let i = 0; i < bundle.accounts.length; i += 1) {
        const account = bundle.accounts[i]
        const plaintext = plaintexts[i]
        if (!account || plaintext === undefined) continue
        try {
          const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
          await ctx.runMutation(internal.subscriptions.mutations.upsertEncrypted, {
            externalId: identity.subject,
            email: account.email,
            ciphertext,
            nonce,
            keyVersion,
            // A4: clamp untrusted timestamps to a 24h ceiling.
            expiresAt: clampExpiresAt(account.expiresAt),
            ...(account.refreshExpiresAt !== undefined
              ? { refreshExpiresAt: clampExpiresAt(account.refreshExpiresAt) }
              : {}),
            subscriptionType: account.subscriptionType,
            rateLimitTier: account.rateLimitTier,
            ...(account.label !== undefined ? { label: account.label } : {}),
          })
          restoredCount += 1
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`${account.email}: ${msg}`)
        }
      }

      // A6: audit row.
      await ctx.runMutation(internal.machineActivity.mutations.record, {
        userId,
        clerkSessionId: resolveCallerSession(identity, clerkSessionId),
        action: 'import',
        at: Date.now(),
        ...(machineLabel !== undefined ? { machineLabel } : {}),
      })

      return { restoredCount, skippedCount, errors }
    } finally {
      // C4: zero the passphrase-derived material.
      derivedKeys.fill(0)
      salt.fill(0)
    }
  },
})
