'use node'

/**
 * Key rotation public + internal actions.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §5.
 *
 * `triggerKeyRotation` is the user-facing entrypoint. It:
 *   1. Resolves the caller's user (used as the audit-row `userId` AND as
 *      the `keyRotationJobs.userId` ownership stamp; the WORK is vault-wide
 *      regardless of who triggered it — see `listSubsForRotation`).
 *   2. Asks `insertJob` to either return an existing pending/running
 *      job's id (A2: atomic existence check) or insert a fresh one.
 *   3. If a fresh job, schedules `rotateAllSubscriptions`.
 *   4. Returns `{ jobId, totalRows }` so the dashboard can poll progress.
 *
 * `rotateAllSubscriptions` (internal) loops every row whose keyVersion
 * differs from the target, decrypts under the row's keyVersion, re-encrypts
 * under the current key, and patches via `patchRotatedRow`. Per-row
 * exceptions increment the job's `errorCount` so the rotation can complete
 * even if a few rows have stale ciphertexts.
 *
 * Vault-wide rotation: under shared-vault doctrine
 * (`convex/utils/users.ts:3-7`) there is ONE master AES key encrypting
 * every row, so a rotation is necessarily vault-wide. Any authed
 * allowlisted email triggering a rotate re-encrypts every co-tenant's
 * rows. The `keyRotationJobs.userId` column on the job row records who
 * KICKED OFF the rotation (for the dashboard's progress UI and the
 * `machineActivity` audit row); the WORK touches every active sub.
 */
import { ConvexError, v } from 'convex/values'

import { internal } from '../_generated/api'
import { type Id } from '../_generated/dataModel'
import { internalAction } from '../_generated/server'
import { currentKeyVersion, decrypt, encrypt } from '../subscriptions/crypto'
import { authenticatedAction, getIdentity } from '../utils/auth'
import { resolveCallerSession } from '../utils/identity'

const triggerResultValidator = v.object({
  jobId: v.id('keyRotationJobs'),
  totalRows: v.number(),
  alreadyRunning: v.boolean(),
})

export const triggerKeyRotation = authenticatedAction({
  args: {
    /**
     * Explicit Clerk session id forwarded by the CLI. BAPI-minted JWTs
     * lack the `sid` claim, so the server prefers `identity.sid` (FAPI)
     * and falls back to this arg via `resolveCallerSession`.
     */
    clerkSessionId: v.optional(v.string()),
    machineLabel: v.optional(v.string()),
  },
  returns: triggerResultValidator,
  handler: async (
    ctx,
    { clerkSessionId, machineLabel }
  ): Promise<{ jobId: Id<'keyRotationJobs'>; totalRows: number; alreadyRunning: boolean }> => {
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

    const targetVersion = currentKeyVersion()
    // Vault-wide: no userId arg — see `listSubsForRotation` for the
    // shared-vault rationale.
    const subs = await ctx.runQuery(internal.subscriptions.internalReads.listSubsForRotation, {
      targetVersion,
    })

    const insertResult = await ctx.runMutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: subs.length,
      toVersion: targetVersion,
    })

    // Audit row (A6): every rotation trigger leaves a row. userId is the
    // ACTING caller's _id (already resolved via getIdByExternalId).
    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId,
      clerkSessionId: resolveCallerSession(identity, clerkSessionId),
      action: 'rotate',
      at: Date.now(),
      ...(machineLabel !== undefined ? { machineLabel } : {}),
    })

    if (insertResult.alreadyRunning) {
      // Another rotation job is already in flight for this user. Return
      // its id so the dashboard can show its progress.
      return { jobId: insertResult.jobId, totalRows: subs.length, alreadyRunning: true }
    }

    if (subs.length === 0) {
      // Fast-path: nothing to do. Mark complete inline so the dashboard
      // doesn't show a spinner forever.
      await ctx.runMutation(internal.keyRotationJobs.mutations.markCompleted, { jobId: insertResult.jobId })
      return { jobId: insertResult.jobId, totalRows: 0, alreadyRunning: false }
    }

    await ctx.runAction(internal.keyRotationJobs.actions.rotateAllSubscriptions, {
      jobId: insertResult.jobId,
      targetVersion,
    })
    return { jobId: insertResult.jobId, totalRows: subs.length, alreadyRunning: false }
  },
})

/**
 * Vault-wide rotation worker. Iterates every active sub whose
 * `keyVersion` differs from `targetVersion` and re-encrypts under the
 * current master key. The `userId` arg was dropped when
 * `listSubsForRotation` became vault-wide — there's no useful per-user
 * partition for the work because all rows decrypt under the same key.
 */
export const rotateAllSubscriptions = internalAction({
  args: {
    jobId: v.id('keyRotationJobs'),
    targetVersion: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { jobId, targetVersion }): Promise<null> => {
    await ctx.runMutation(internal.keyRotationJobs.mutations.markRunning, { jobId })

    const subs = await ctx.runQuery(internal.subscriptions.internalReads.listSubsForRotation, {
      targetVersion,
    })

    for (const sub of subs) {
      try {
        const plaintext = decrypt(sub.ciphertext, sub.nonce, sub.keyVersion)
        const reEncrypted = encrypt(plaintext)
        await ctx.runMutation(internal.subscriptions.mutations.patchRotatedRow, {
          subId: sub._id,
          ciphertext: reEncrypted.ciphertext,
          nonce: reEncrypted.nonce,
          keyVersion: reEncrypted.keyVersion,
        })
        await ctx.runMutation(internal.keyRotationJobs.mutations.incrementProgress, {
          jobId,
          deltaProcessed: 1,
          deltaErrors: 0,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await ctx.runMutation(internal.keyRotationJobs.mutations.incrementProgress, {
          jobId,
          deltaProcessed: 0,
          deltaErrors: 1,
          lastError: msg,
        })
      }
    }

    await ctx.runMutation(internal.keyRotationJobs.mutations.markCompleted, { jobId })
    return null
  },
})
