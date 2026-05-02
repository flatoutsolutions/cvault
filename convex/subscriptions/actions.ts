'use node'

/**
 * Subscriptions actions — Anthropic OAuth refresh, usage fetch, and
 * pull-on-use credential rotation.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5 + §9 + §10.
 *
 * All functions here run in the Node.js runtime so they can use
 * `node:crypto` and the global `fetch` to talk to Anthropic.
 */
import { ConvexError, v } from 'convex/values'

import { internal } from '../_generated/api'
import { internalAction } from '../_generated/server'
import { authenticatedAction, getIdentity } from '../utils/auth'
import { fetchUsage, generateHolderToken, refreshAccessToken } from './anthropic'
import { decrypt, encrypt } from './crypto'
import { redactTokens } from './redact'

// ---------------------------------------------------------------------------
// pullForSwitch — public action used by `cvault switch`
// ---------------------------------------------------------------------------

const pullResultValidator = v.object({
  email: v.string(),
  slot: v.number(),
  plaintextBlob: v.string(),
  contentHash: v.string(),
})

const REFRESH_PROACTIVE_MS = 5 * 60 * 1000

async function sha256Hex(input: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(input).digest('hex')
}

export const pullForSwitch = authenticatedAction({
  args: { slotOrEmail: v.string() },
  returns: pullResultValidator,
  handler: async (
    ctx,
    { slotOrEmail }
  ): Promise<{
    email: string
    slot: number
    plaintextBlob: string
    contentHash: string
  }> => {
    const identity = getIdentity(ctx)
    // Read the sub via an internal query so we can see ciphertext + nonce.
    const sub = await ctx.runQuery(internal.subscriptions.internalReads.getSubscriptionForActor, {
      externalId: identity.subject,
      slotOrEmail,
    })
    if (!sub) {
      throw new ConvexError({ code: 'NOT_FOUND', message: `No subscription matching: ${slotOrEmail}` })
    }

    // Refresh proactively if access token expires soon.
    const now = Date.now()
    const proactiveRefreshAttempted = sub.expiresAt < now + REFRESH_PROACTIVE_MS
    if (proactiveRefreshAttempted) {
      await ctx.runAction(internal.subscriptions.actions.refreshOAuthToken, {
        subId: sub._id,
        triggeredBy: 'onUse',
      })
    }

    // Re-read after potential refresh to get the fresh ciphertext.
    const fresh = await ctx.runQuery(internal.subscriptions.internalReads.getSubscriptionByIdForActor, {
      externalId: identity.subject,
      subId: sub._id,
    })
    if (!fresh) {
      throw new ConvexError({ code: 'GONE', message: 'Subscription disappeared mid-pull' })
    }

    // SECURITY/UX: if we attempted a proactive refresh but the row's
    // expiresAt is still in the past, the refresh definitively failed
    // (Anthropic 5xx, network error, lease lost, etc.). Returning the
    // stale plaintext would let the CLI hand the user a token that's
    // about to fail at Anthropic with an opaque 401 — the user would
    // have no idea cvault was involved. Surface a clear error so the
    // CLI can prompt the user to retry or `cvault refresh` manually.
    if (proactiveRefreshAttempted && fresh.expiresAt < Date.now()) {
      throw new ConvexError({
        code: 'REFRESH_FAILED',
        message:
          'Anthropic OAuth refresh failed and stored token is expired. ' +
          'Try `cvault refresh ' +
          slotOrEmail +
          '` again, or check /dashboard/audit for details.',
      })
    }

    // Audit: record this pull. Clerk JWT 'sid' claim is the session id; if
    // it's somehow missing we fall back to a marker so the row still inserts.
    const sidClaim = (identity as { sid?: unknown }).sid
    const clerkSessionId = typeof sidClaim === 'string' ? sidClaim : 'unknown-session'
    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId: fresh.userId,
      clerkSessionId,
      action: 'pull',
      subscriptionId: fresh._id,
      at: Date.now(),
    })

    const plaintext = decrypt(fresh.ciphertext, fresh.nonce)
    const contentHash = await sha256Hex(plaintext)
    return {
      email: fresh.email,
      slot: fresh.slot,
      plaintextBlob: plaintext,
      contentHash,
    }
  },
})

// ---------------------------------------------------------------------------
// upsertFromPlaintext — public action used by `cvault add`. The CLI sends
// the plaintext `claudeAiOauth` JSON; the server encrypts under
// VAULT_AES_KEY and persists. We expose this as an action (not a
// mutation) because mutations can't use `node:crypto`, and we never want
// the CLI to hold the master key.
// ---------------------------------------------------------------------------

const upsertResultValidator = v.object({
  subId: v.id('subscriptions'),
  userId: v.id('users'),
  slot: v.number(),
  created: v.boolean(),
})

export const upsertFromPlaintext = authenticatedAction({
  args: {
    email: v.string(),
    plaintextBlob: v.string(),
    expiresAt: v.number(),
    refreshExpiresAt: v.optional(v.number()),
    subscriptionType: v.string(),
    rateLimitTier: v.string(),
    label: v.optional(v.string()),
  },
  returns: upsertResultValidator,
  handler: async (
    ctx,
    args
  ): Promise<{
    subId: import('../_generated/dataModel').Id<'subscriptions'>
    userId: import('../_generated/dataModel').Id<'users'>
    slot: number
    created: boolean
  }> => {
    const identity = getIdentity(ctx)
    const { ciphertext, nonce } = encrypt(args.plaintextBlob)
    const result = await ctx.runMutation(internal.subscriptions.mutations.upsertEncrypted, {
      externalId: identity.subject,
      email: args.email,
      ciphertext,
      nonce,
      expiresAt: args.expiresAt,
      refreshExpiresAt: args.refreshExpiresAt,
      subscriptionType: args.subscriptionType,
      rateLimitTier: args.rateLimitTier,
      label: args.label,
    })
    // Audit: record the add. Per spec §4 + §12 every authenticated
    // state-changing action emits a `machineActivity` row.
    const sidClaim = (identity as { sid?: unknown }).sid
    const clerkSessionId = typeof sidClaim === 'string' ? sidClaim : 'unknown-session'
    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId: result.userId,
      clerkSessionId,
      action: 'add',
      subscriptionId: result.subId,
      at: Date.now(),
    })
    return result
  },
})

// ---------------------------------------------------------------------------
// requestRefresh — public wrapper for the dashboard "Force Refresh" button
// and `cvault refresh` CLI command. Verifies the caller owns the sub
// before delegating to the internal `refreshOAuthToken` action.
// ---------------------------------------------------------------------------

export const requestRefresh = authenticatedAction({
  args: { subId: v.id('subscriptions') },
  returns: v.null(),
  handler: async (ctx, { subId }): Promise<null> => {
    const identity = getIdentity(ctx)
    // Confirm the sub belongs to the caller.
    const sub = await ctx.runQuery(internal.subscriptions.internalReads.getSubscriptionByIdForActor, {
      externalId: identity.subject,
      subId,
    })
    if (!sub) {
      throw new ConvexError({
        code: 'NOT_FOUND',
        message: 'Subscription not found or not owned by current user',
      })
    }

    await ctx.runAction(internal.subscriptions.actions.refreshOAuthToken, {
      subId,
      triggeredBy: 'manual',
    })

    // Audit: record the user-initiated refresh. Per spec §4 + §12.
    const sidClaim = (identity as { sid?: unknown }).sid
    const clerkSessionId = typeof sidClaim === 'string' ? sidClaim : 'unknown-session'
    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId: sub.userId,
      clerkSessionId,
      action: 'refresh',
      subscriptionId: subId,
      at: Date.now(),
    })
    return null
  },
})

// ---------------------------------------------------------------------------
// refreshOAuthToken — internal, called by pullForSwitch / cron / manual UI
// ---------------------------------------------------------------------------

export const refreshOAuthToken = internalAction({
  args: {
    subId: v.id('subscriptions'),
    triggeredBy: v.union(v.literal('cron'), v.literal('manual'), v.literal('onUse')),
  },
  returns: v.null(),
  handler: async (ctx, { subId, triggeredBy }): Promise<null> => {
    const holderToken = generateHolderToken()

    // Step 1: try to acquire the lease.
    const lease = await ctx.runMutation(internal.subscriptions.mutations.tryAcquireRefreshLease, {
      subId,
      holderToken,
    })
    if (!lease.acquired) {
      // Loser: per spec §9 we sleep 1 second and re-check. If the sub is
      // already fresh after the winner's commit, we abort silently.
      await new Promise((res) => setTimeout(res, 1000))
      const recheck = await ctx.runQuery(internal.subscriptions.internalReads.getSubscriptionRaw, { subId })
      if (!recheck || recheck.expiresAt > Date.now() + REFRESH_PROACTIVE_MS) {
        return null
      }
      // Still expired and lease still busy — bail out without logging
      // (we don't own this attempt).
      return null
    }

    // Step 2: load the sub, decrypt, refresh.
    const sub = await ctx.runQuery(internal.subscriptions.internalReads.getSubscriptionRaw, { subId })
    if (!sub) {
      await ctx.runMutation(internal.subscriptions.mutations.releaseRefreshLease, { subId, holderToken })
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Subscription disappeared mid-refresh' })
    }

    // Decrypt may throw if the ciphertext is tampered, the master key
    // rotated, or the nonce got mangled. We MUST NOT let this propagate
    // out of the action — that would leave the lease held for the full
    // 30s TTL and skip the audit row, hiding the corruption from the
    // dashboard. Per spec §10: "Decrypt failure (GCM auth tag) → Throw,
    // log error w/ subId; surface as 'creds corrupt — re-add'".
    let plaintext: string
    try {
      plaintext = decrypt(sub.ciphertext, sub.nonce)
    } catch (err) {
      await ctx.runMutation(internal.subscriptions.mutations.releaseRefreshLease, {
        subId,
        holderToken,
      })
      const errMsg = err instanceof Error ? err.message : String(err)
      await ctx.runMutation(internal.refreshLog.mutations.insert, {
        userId: sub.userId,
        subscriptionId: subId,
        triggeredBy,
        outcome: 'failure',
        error: redactTokens(`decrypt failed (creds corrupt — re-add account): ${errMsg}`),
        at: Date.now(),
      })
      return null
    }

    type OAuthBlob = {
      claudeAiOauth?: {
        accessToken?: string
        refreshToken?: string
        expiresAt?: number
        scopes?: Array<string>
      }
    }
    const blob = JSON.parse(plaintext) as OAuthBlob
    const refreshToken = blob.claudeAiOauth?.refreshToken
    if (!refreshToken) {
      await ctx.runMutation(internal.subscriptions.mutations.releaseRefreshLease, { subId, holderToken })
      await ctx.runMutation(internal.refreshLog.mutations.insert, {
        userId: sub.userId,
        subscriptionId: subId,
        triggeredBy,
        outcome: 'failure',
        error: 'no refreshToken in stored blob; re-add account required',
        at: Date.now(),
      })
      return null
    }

    // Step 3: hit Anthropic.
    const result = await refreshAccessToken(refreshToken)

    if (!result.ok) {
      // Per docs/research/anthropic-oauth-refresh.md, both 400 and 401 with
      // an OAuth-standard `error: "invalid_grant"` body mean the refresh
      // token itself is dead — owner must re-login. Other 4xx/5xx are
      // transient and just logged as failure.
      let isReloginRequired = false
      if (result.kind === 'http' && (result.status === 400 || result.status === 401)) {
        try {
          const parsed = JSON.parse(result.rawBody) as { error?: unknown }
          if (parsed.error === 'invalid_grant') {
            isReloginRequired = true
          }
        } catch {
          // Body wasn't JSON. Be conservative: a bare 401 is treated as
          // reloginRequired (Anthropic seems to rarely return non-JSON).
          if (result.status === 401) {
            isReloginRequired = true
          }
        }
      }
      const outcome = isReloginRequired ? 'reloginRequired' : 'failure'

      let errMsg: string
      if (result.kind === 'network') {
        errMsg = `Anthropic refresh network error: ${result.message}`
      } else {
        errMsg = `Anthropic refresh ${result.status.toString()}: ${result.rawBody.slice(0, 500)}`
      }
      const safeError = redactTokens(errMsg)

      if (isReloginRequired) {
        await ctx.runMutation(internal.subscriptions.mutations.markReloginRequired, {
          subId,
          holderToken,
        })
      } else {
        await ctx.runMutation(internal.subscriptions.mutations.releaseRefreshLease, {
          subId,
          holderToken,
        })
      }
      await ctx.runMutation(internal.refreshLog.mutations.insert, {
        userId: sub.userId,
        subscriptionId: subId,
        triggeredBy,
        outcome,
        error: safeError,
        at: Date.now(),
      })
      return null
    }

    // Step 4: build the new plaintext and re-encrypt.
    const nowMs = Date.now()
    const newOauth = {
      ...(blob.claudeAiOauth ?? {}),
      accessToken: result.accessToken,
      expiresAt: nowMs + result.expiresIn * 1000,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      ...(result.scope ? { scopes: result.scope.split(' ') } : {}),
    }
    const newPlaintext = JSON.stringify({ ...blob, claudeAiOauth: newOauth })
    const { ciphertext, nonce } = encrypt(newPlaintext)

    // Step 5: commit, releasing the lease atomically.
    await ctx.runMutation(internal.subscriptions.mutations.commitRefreshedTokens, {
      subId,
      holderToken,
      ciphertext,
      nonce,
      expiresAt: nowMs + result.expiresIn * 1000,
      lastRefreshedAt: nowMs,
    })

    await ctx.runMutation(internal.refreshLog.mutations.insert, {
      userId: sub.userId,
      subscriptionId: subId,
      triggeredBy,
      outcome: 'success',
      at: Date.now(),
    })
    return null
  },
})

// ---------------------------------------------------------------------------
// fetchUsageForSub — internal, called by pollUsage cron
// ---------------------------------------------------------------------------

export const fetchUsageForSub = internalAction({
  args: { subId: v.id('subscriptions') },
  returns: v.null(),
  handler: async (ctx, { subId }): Promise<null> => {
    const sub = await ctx.runQuery(internal.subscriptions.internalReads.getSubscriptionRaw, { subId })
    if (!sub || sub.removedAt !== undefined) return null

    // Per spec §10, usage failures are silent (the next 5-minute tick
    // will retry). If decrypt throws here we'd cause the whole cron run
    // to reject (unless caller wraps in allSettled — see crons.ts) and
    // also mask the corruption from any audit. Treat decrypt failure as
    // a quiet skip with a console.error so it shows up in Convex logs.
    let plaintext: string
    try {
      plaintext = decrypt(sub.ciphertext, sub.nonce)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[cvault] fetchUsageForSub: decrypt failed for subId ${subId}: ${redactTokens(errMsg)}`)
      return null
    }
    type OAuthBlob = { claudeAiOauth?: { accessToken?: string } }
    const blob = JSON.parse(plaintext) as OAuthBlob
    const accessToken = blob.claudeAiOauth?.accessToken
    if (!accessToken) return null

    const result = await fetchUsage(accessToken)
    if (!result.ok) {
      // 429 / network errors: silent skip per spec §10. Try again next tick.
      return null
    }

    const fetchedAt = Date.now()
    await ctx.runMutation(internal.subscriptions.mutations.patchUsage, {
      subId,
      usage5h: result.fiveHour
        ? { pct: result.fiveHour.pct, resetsAt: result.fiveHour.resetsAtMs, fetchedAt }
        : undefined,
      usage7d: result.sevenDay
        ? { pct: result.sevenDay.pct, resetsAt: result.sevenDay.resetsAtMs, fetchedAt }
        : undefined,
    })
    return null
  },
})
