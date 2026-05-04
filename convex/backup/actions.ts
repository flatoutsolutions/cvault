'use node'

/**
 * Encrypted backup export + import actions.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
 *
 * Bundle format: passphrase-derived AES-256-GCM key (via scrypt) wrapping
 * each account's plaintext credential blob with a fresh nonce. The
 * bundle is base64-encoded JSON; the operator downloads it, stores it
 * out-of-band, and can restore via `importEncryptedBackup` later.
 *
 * Per the 2026-05-04 review:
 * - A6: every export/import emits a `machineActivity` row (these are
 *   the highest-impact ops in the system; audit MUST capture them).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

import { ConvexError, v } from 'convex/values'

import { internal } from '../_generated/api'
import { decrypt, encrypt } from '../subscriptions/crypto'
import { authenticatedAction, getIdentity } from '../utils/auth'
import { type BackupAccount, type CvaultBackupBundle, SCRYPT_PARAMS, buildBundle, parseBundle } from './bundle'

const MIN_PASSPHRASE_LEN = 12
const SALT_BYTES = 16
const NONCE_BYTES = 12
const DERIVED_KEY_BYTES = 32
const SCRYPT_MAX_MEM = 64 * 1024 * 1024

function deriveKey(passphrase: string, saltBuf: Buffer): Buffer {
  return scryptSync(passphrase, saltBuf, DERIVED_KEY_BYTES, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAX_MEM,
  })
}

function aesGcmEncrypt(key: Buffer, plaintext: string): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { ciphertext: Buffer.concat([enc, tag]), nonce }
}

function aesGcmDecrypt(key: Buffer, bundle: Buffer, nonce: Buffer): string {
  const tag = bundle.subarray(bundle.byteLength - 16)
  const enc = bundle.subarray(0, bundle.byteLength - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
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

function clerkSessionFromIdentity(identity: { sid?: unknown }): string {
  const sid = identity.sid
  return typeof sid === 'string' && sid.length > 0 ? sid : 'unknown-session'
}

export const exportEncryptedBackup = authenticatedAction({
  args: {
    passphrase: v.string(),
    /**
     * Optional explicit Clerk session id from the caller. PR #9 lands a
     * `convex/utils/identity.ts:resolveCallerSession(identity, argSid)`
     * helper that prefers this arg over the JWT claim. PENDING:
     * replace the inline resolver below with `resolveCallerSession`
     * after PR #9 rebase.
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

    const subs = await ctx.runQuery(internal.subscriptions.internalReads.listSubsForUserId, {
      userId,
    })

    const salt = randomBytes(SALT_BYTES)
    const derivedKey = deriveKey(passphrase, salt)

    const accounts: BackupAccount[] = []
    for (const sub of subs) {
      const plaintext = decrypt(sub.ciphertext, sub.nonce, sub.keyVersion)
      const { ciphertext, nonce } = aesGcmEncrypt(derivedKey, plaintext)
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

    const bundle: CvaultBackupBundle = buildBundle({
      saltBase64: salt.toString('base64'),
      accounts,
      now: Date.now(),
    })
    const contentBase64 = Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64')

    // A6: audit row. No subscriptionId — this is a bulk operation.
    // PENDING: replace inline session resolver with resolveCallerSession after PR #9 rebase.
    const resolvedSid = clerkSessionId ?? clerkSessionFromIdentity(identity as { sid?: unknown })
    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId,
      clerkSessionId: resolvedSid,
      action: 'export',
      at: Date.now(),
      ...(machineLabel !== undefined ? { machineLabel } : {}),
    })

    return {
      filename: `cvault-backup-${todayDateStamp()}.cvb`,
      contentBase64,
      accountCount: accounts.length,
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
     * PENDING: see exportEncryptedBackup's docstring; same PR #9 contract.
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
    const derivedKey = deriveKey(passphrase, salt)

    // A3 (refuse-overwrite): reject the import upfront if any of the
    // bundle's emails already have a LIVE sub for this user. This avoids
    // the silent-replace-of-current-credentials disaster path that
    // upsertEncrypted's dedupe-by-(userId, email) would otherwise enable.
    const existingLive = await ctx.runQuery(internal.subscriptions.internalReads.listSubsForUserId, {
      userId,
    })
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
    // If ANY account fails to decrypt under the supplied passphrase, throw
    // BACKUP_BAD_PASSPHRASE without touching the DB. Only after all
    // plaintexts are recovered does pass 2 re-encrypt + persist.
    const plaintexts: string[] = []
    for (const account of bundle.accounts) {
      try {
        const acctCipher = Buffer.from(account.ciphertext, 'base64')
        const acctNonce = Buffer.from(account.nonce, 'base64')
        plaintexts.push(aesGcmDecrypt(derivedKey, acctCipher, acctNonce))
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
    // PENDING: replace inline session resolver with resolveCallerSession after PR #9 rebase.
    const resolvedSid = clerkSessionId ?? clerkSessionFromIdentity(identity as { sid?: unknown })
    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId,
      clerkSessionId: resolvedSid,
      action: 'import',
      at: Date.now(),
      ...(machineLabel !== undefined ? { machineLabel } : {}),
    })

    return { restoredCount, skippedCount, errors }
  },
})
