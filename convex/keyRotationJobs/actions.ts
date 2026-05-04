'use node'

/**
 * Key rotation public + internal actions.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §5.
 *
 * `triggerKeyRotation` is the user-facing entrypoint. It:
 *   1. Resolves the caller's user.
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
    const subs = await ctx.runQuery(internal.subscriptions.internalReads.listSubsForRotation, {
      userId,
      targetVersion,
    })

    const insertResult = await ctx.runMutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: subs.length,
      toVersion: targetVersion,
    })

    // Audit row (A6): every rotation trigger leaves a row.
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
      userId,
      targetVersion,
    })
    return { jobId: insertResult.jobId, totalRows: subs.length, alreadyRunning: false }
  },
})

export const rotateAllSubscriptions = internalAction({
  args: {
    jobId: v.id('keyRotationJobs'),
    userId: v.id('users'),
    targetVersion: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { jobId, userId, targetVersion }): Promise<null> => {
    await ctx.runMutation(internal.keyRotationJobs.mutations.markRunning, { jobId })

    const subs = await ctx.runQuery(internal.subscriptions.internalReads.listSubsForRotation, {
      userId,
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
