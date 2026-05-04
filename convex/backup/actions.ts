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
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'

import { ConvexError, v } from 'convex/values'

import { internal } from '../_generated/api'
import { decrypt } from '../subscriptions/crypto'
import { authenticatedAction, getIdentity } from '../utils/auth'
import { type BackupAccount, type CvaultBackupBundle, SCRYPT_PARAMS, buildBundle } from './bundle'

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
    machineLabel: v.optional(v.string()),
  },
  returns: exportResultValidator,
  handler: async (
    ctx,
    { passphrase, machineLabel }
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
    const clerkSessionId = clerkSessionFromIdentity(identity as { sid?: unknown })
    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId,
      clerkSessionId,
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
