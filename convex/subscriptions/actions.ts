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
import { resolveCallerSession } from '../utils/identity'
import { fetchUsage, generateHolderToken, refreshAccessToken } from './anthropic'
import { decrypt, encrypt } from './crypto'
import { redactTokens } from './redact'

// ---------------------------------------------------------------------------
// pullForSwitch — public action used by `cvault switch`
// ---------------------------------------------------------------------------

/** Sentinel written in place of a usable refresh token so clients can never
 *  rotate the shared grant — only the vault refreshes (single writer). */
export const NEUTERED_REFRESH_TOKEN = 'cvault-neutered-no-refresh'

function neuterBlobRefreshToken(plaintext: string): string {
  const blob = JSON.parse(plaintext) as { claudeAiOauth?: { refreshToken?: string } }
  if (blob.claudeAiOauth) blob.claudeAiOauth.refreshToken = NEUTERED_REFRESH_TOKEN
  return JSON.stringify(blob)
}

/**
 * Reject a plaintext blob that still carries the neutered sentinel. After a
 * machine runs `cvault switch`/`pull`, its local keychain holds
 * NEUTERED_REFRESH_TOKEN in place of a usable refresh token. `cvault add`
 * re-reads that keychain, so writing such a blob back into the vault would
 * clobber the real refresh token the vault is the sole keeper of — the next
 * proactive refresh would send the sentinel to Anthropic, earn `invalid_grant`,
 * and log out every machine on the shared grant. Malformed JSON is left to the
 * caller's own parse step; we only block the specific poisoning case.
 */
function assertNotNeutered(plaintext: string): void {
  let refreshToken: unknown
  try {
    refreshToken = (JSON.parse(plaintext) as { claudeAiOauth?: { refreshToken?: unknown } }).claudeAiOauth?.refreshToken
  } catch {
    return
  }
  if (refreshToken === NEUTERED_REFRESH_TOKEN) {
    throw new ConvexError({
      code: 'NEUTERED_TOKEN',
      message:
        'This machine holds a neutered (vault-managed) refresh token, so it cannot capture a subscription. ' +
        'The vault already has this account; run `cvault add` from a machine where you signed in to claude directly.',
    })
  }
}

const pullResultValidator = v.object({
  email: v.string(),
  slot: v.number(),
  plaintextBlob: v.string(),
  contentHash: v.string(),
})

export const REFRESH_PROACTIVE_MS = 5 * 60 * 1000

async function sha256Hex(input: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(input).digest('hex')
}

export const pullForSwitch = authenticatedAction({
  args: {
    slotOrEmail: v.string(),
    /**
     * Human-readable identifier for the originating CLI machine. The
     * dashboard's "Machines" section renders this as the user-visible
     * label (otherwise it would only see opaque session ids). Optional —
     * see `machineActivity/schema.ts:machineLabel` for the contract.
     */
    machineLabel: v.optional(v.string()),
    /**
     * Machine id of the caller (CVLT-3: replaces clerkSessionId). CLI clients
     * pass their persistent machine UUID. Optional for backward-compat with
     * older CLI callers that pre-date the PKCE migration.
     */
    machineId: v.optional(v.string()),
    /**
     * When true, the returned `plaintextBlob` has its
     * `claudeAiOauth.refreshToken` replaced with `NEUTERED_REFRESH_TOKEN`
     * so the client can never rotate the shared grant. The vault remains
     * the sole OAuth refresher. Default false (backward-compat).
     */
    neuterRefreshToken: v.optional(v.boolean()),
    /**
     * When true, skip the `machineActivity` audit row. Set by the background
     * `cvault pull` hook, which runs before EVERY claude prompt — auditing
     * each one would flood the table and bury real activity. Interactive
     * callers (`switch`/`sync`) leave it unset so their pulls stay on the
     * audit trail. Default false (record the row).
     */
    silent: v.optional(v.boolean()),
  },
  returns: pullResultValidator,
  handler: async (
    ctx,
    { slotOrEmail, machineLabel, machineId: callerArgSid, neuterRefreshToken, silent }
  ): Promise<{
    email: string
    slot: number
    plaintextBlob: string
    contentHash: string
  }> => {
    const identity = getIdentity(ctx)
    // Read the sub via an internal query so we can see ciphertext + nonce.
    // Shared-vault: the lookup is global; the `authenticatedAction` wrapper
    // already enforced Clerk + allowedEmailDomains.
    const sub = await ctx.runQuery(internal.subscriptions.internalReads.getSubscriptionBySlotOrEmail, {
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
    const fresh = await ctx.runQuery(internal.subscriptions.internalReads.getSubscriptionById, {
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
    // have no idea cvault was involved. Surface a clear error so the CLI
    // can prompt the user to retry; the vault is the sole refresher now,
    // so recovery is to retry shortly (the cron will rotate it) or, if the
    // refresh token itself is dead, re-capture with `cvault add` on a
    // machine signed in to claude directly.
    if (proactiveRefreshAttempted && fresh.expiresAt < Date.now()) {
      throw new ConvexError({
        code: 'REFRESH_FAILED',
        message:
          `Anthropic OAuth refresh failed and the stored token for ${slotOrEmail} is expired. ` +
          'Retry in a moment (the vault refreshes automatically), or check /dashboard/audit for details. ' +
          'If it persists, re-capture with `cvault add` from a machine signed in to claude.',
      })
    }

    // Audit: record this pull. CLI BAPI-minted JWTs do not carry a `sid`
    // claim so we accept it as an explicit arg, preferring the verified
    // identity claim when present (FAPI/dashboard origin).
    //
    // userId is the ACTING user's `users._id`, NOT `fresh.userId` (the
    // sub owner). Pre-fix the row recorded the sub owner, so under
    // shared-vault `cvault sync --all` from saad's machine pulling
    // samuel's row would falsely attribute the pull to samuel. Resolve
    // the caller's user via the same internal helper used by
    // backup/keyRotation (see `internal.users.actions.getIdByExternalId`).
    //
    // Skipped entirely for `silent` (background hook) pulls — the hook runs
    // before every claude prompt, so a row per pull would flood the audit
    // table; and a missing user row must NOT throw on that path (the hook is
    // best-effort and never blocks the prompt). Interactive switch/sync pulls
    // leave `silent` unset and keep their audit trail.
    if (silent !== true) {
      const actorUserId = await ctx.runQuery(internal.users.actions.getIdByExternalId, {
        externalId: identity.subject,
      })
      if (!actorUserId) {
        // The Clerk webhook hasn't yet inserted a row for the caller. We
        // could silently skip the audit, but skipping a pull's audit row
        // is a worse failure mode than throwing — pulls hand plaintext
        // tokens to the CLI; an audit gap on that path makes incident
        // forensics impossible. Throw with the same shape the
        // backup/keyRotation actions already use.
        throw new ConvexError({
          code: 'USER_NOT_FOUND',
          message: 'No user row for caller. Sign in once to trigger the Clerk webhook, then retry.',
        })
      }
      await ctx.runMutation(internal.machineActivity.mutations.record, {
        userId: actorUserId,
        machineId: callerArgSid ?? resolveCallerSession(identity),
        action: 'pull',
        subscriptionId: fresh._id,
        at: Date.now(),
        ...(machineLabel !== undefined ? { machineLabel } : {}),
      })
    }

    const decrypted = decrypt(fresh.ciphertext, fresh.nonce, fresh.keyVersion)
    const plaintext = neuterRefreshToken === true ? neuterBlobRefreshToken(decrypted) : decrypted
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
    machineLabel: v.optional(v.string()),
    /** Machine id (CVLT-3: replaces clerkSessionId). See pullForSwitch.machineId. */
    machineId: v.optional(v.string()),
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
    assertNotNeutered(args.plaintextBlob)
    const { ciphertext, nonce, keyVersion } = encrypt(args.plaintextBlob)
    const result = await ctx.runMutation(internal.subscriptions.mutations.upsertEncrypted, {
      externalId: identity.subject,
      email: args.email,
      ciphertext,
      nonce,
      keyVersion,
      expiresAt: args.expiresAt,
      refreshExpiresAt: args.refreshExpiresAt,
      subscriptionType: args.subscriptionType,
      rateLimitTier: args.rateLimitTier,
      label: args.label,
    })
    // Audit: record the add. Per spec §4 + §12 every authenticated
    // state-changing action emits a `machineActivity` row.
    //
    // userId is the ACTING caller's `users._id` (resolved from the verified
    // `identity.subject`), NOT `result.userId` (the sub owner). Under the
    // shared-vault "first claimer wins" policy (`upsertSub`), re-capturing an
    // account someone else already added returns the ORIGINAL owner's userId —
    // so attributing the audit row to `result.userId` falsely logged the add
    // against the first claimer while stamping the actual caller's machine,
    // producing impossible "userX added on userY's machine" rows. Mirrors the
    // actor-vs-owner fix in pullForSwitch / requestRefresh / softRemove / rename.
    const actorUserId = await ctx.runQuery(internal.users.actions.getIdByExternalId, {
      externalId: identity.subject,
    })
    if (!actorUserId) {
      throw new ConvexError({
        code: 'USER_NOT_FOUND',
        message: 'No user row for caller. Sign in once to trigger the Clerk webhook, then retry.',
      })
    }
    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId: actorUserId,
      machineId: args.machineId ?? resolveCallerSession(identity),
      action: 'add',
      subscriptionId: result.subId,
      at: Date.now(),
      ...(args.machineLabel !== undefined ? { machineLabel: args.machineLabel } : {}),
    })
    // Kick off an immediate usage fetch so the dashboard shows
    // the 5h/7d percentages as soon as the sub appears, rather than
    // blank until the next pollUsage cron tick (up to 5 min later).
    // Scheduled (not awaited) so cvault add stays snappy + a usage
    // failure can never block the upsert from succeeding.
    await ctx.scheduler.runAfter(0, internal.subscriptions.actions.fetchUsageForSub, {
      subId: result.subId,
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
  args: {
    subId: v.id('subscriptions'),
    machineLabel: v.optional(v.string()),
    /** Machine id (CVLT-3: replaces clerkSessionId). See pullForSwitch.machineId. */
    machineId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { subId, machineLabel, machineId: callerArgSid }): Promise<null> => {
    const identity = getIdentity(ctx)
    // Shared-vault: any authed allowed-domain caller resolves any sub.
    // The `authenticatedAction` wrapper is the only access gate.
    const sub = await ctx.runQuery(internal.subscriptions.internalReads.getSubscriptionById, {
      subId,
    })
    if (!sub) {
      throw new ConvexError({
        code: 'NOT_FOUND',
        message: 'Subscription not found',
      })
    }

    await ctx.runAction(internal.subscriptions.actions.refreshOAuthToken, {
      subId,
      triggeredBy: 'manual',
    })

    // Audit: record the user-initiated refresh. Per spec §4 + §12.
    // userId is the ACTING user's _id (resolved from identity.subject),
    // NOT `sub.userId` (the sub owner). Pre-fix this attributed
    // dashboard "Force Refresh" clicks to whoever originally added the
    // sub; corrected to attribute the actual click. See pullForSwitch.
    const actorUserId = await ctx.runQuery(internal.users.actions.getIdByExternalId, {
      externalId: identity.subject,
    })
    if (!actorUserId) {
      throw new ConvexError({
        code: 'USER_NOT_FOUND',
        message: 'No user row for caller. Sign in once to trigger the Clerk webhook, then retry.',
      })
    }
    await ctx.runMutation(internal.machineActivity.mutations.record, {
      userId: actorUserId,
      machineId: callerArgSid ?? resolveCallerSession(identity),
      action: 'refresh',
      subscriptionId: subId,
      at: Date.now(),
      ...(machineLabel !== undefined ? { machineLabel } : {}),
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
    triggeredBy: v.union(v.literal('manual'), v.literal('onUse')),
    /**
     * When `true`, skip the M1 lease-winner re-check — the user
     * explicitly asked for a rotation regardless of whether the row
     * already looks fresh. Default `false`.
     *
     * The `--force` flag on `cvault refresh` and the dashboard "Force
     * Refresh" button set this; cron / proactive-onUse paths leave it
     * unset so the M1 race protection avoids burning Anthropic calls
     * (and triggering RT rotations on other laptops) when another
     * caller already refreshed concurrently.
     */
    force: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { subId, triggeredBy, force }): Promise<null> => {
    // N4: capture nowMs once at the start so all downstream comparisons
    // (lease re-check, refreshLog `at`, machineActivity `at`) share the
    // same reference moment. Mixed `Date.now()` calls within one action
    // can drift by tens of ms across awaits — small but observable in
    // races between the proactive-refresh window check and the audit
    // row's at-timestamp.
    const nowMs = Date.now()
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

    // Two post-lease re-checks share one read. Both decisions need the
    // freshest row; doing them in one query halves the read.
    //
    // 1. RT-dead spam guard: a manual `cvault refresh` or pull-on-use
    //    caller could arrive here with a sub whose `refreshExpiresAt
    //    <= now` (Anthropic already told us the RT is dead via a prior
    //    `invalid_grant`). Re-driving Anthropic in that state would just
    //    earn another `invalid_grant` and a duplicate `reloginRequired`
    //    log row. Drop the lease and exit silently — the original
    //    `reloginRequired` row is enough; further rows are noise. This
    //    check runs regardless of `force` because no value of `--force`
    //    makes Anthropic accept a dead RT; the only recovery is
    //    `cvault add` to re-capture a fresh blob.
    //
    // 2. M1 (race protection): two callers can each independently decide
    //    "needs refresh" against stale reads; the loser then acquires the
    //    lease AFTER the winner already committed a new (rotated) RT.
    //    Without this re-check, the loser would burn an Anthropic call
    //    (and trigger another RT rotation, invalidating any other laptop
    //    holding the prior RT). `force === true` (user-initiated
    //    `cvault refresh --force`) bypasses ONLY this M1 short-circuit
    //    because the user explicitly asked us to rotate against
    //    Anthropic — the relogin guard above always fires.
    const freshPostLease = await ctx.runQuery(internal.subscriptions.internalReads.getSubscriptionRaw, { subId })
    if (freshPostLease && freshPostLease.refreshExpiresAt !== undefined && freshPostLease.refreshExpiresAt <= nowMs) {
      await ctx.runMutation(internal.subscriptions.mutations.releaseRefreshLease, { subId, holderToken })
      return null
    }
    if (force !== true && freshPostLease && freshPostLease.expiresAt > nowMs + REFRESH_PROACTIVE_MS) {
      // Another caller already refreshed; the row is fresh now. Drop
      // the lease and exit silently — we don't own this attempt's
      // outcome.
      await ctx.runMutation(internal.subscriptions.mutations.releaseRefreshLease, { subId, holderToken })
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
      plaintext = decrypt(sub.ciphertext, sub.nonce, sub.keyVersion)
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
        at: nowMs,
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
        at: nowMs,
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
        at: nowMs,
      })
      return null
    }

    // Step 4: build the new plaintext and re-encrypt. Use the same nowMs
    // captured at the start of the action so audit rows + token expiry
    // share one reference moment.
    const newOauth = {
      ...(blob.claudeAiOauth ?? {}),
      accessToken: result.accessToken,
      expiresAt: nowMs + result.expiresIn * 1000,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      ...(result.scope ? { scopes: result.scope.split(' ') } : {}),
    }
    const newPlaintext = JSON.stringify({ ...blob, claudeAiOauth: newOauth })
    const { ciphertext, nonce, keyVersion } = encrypt(newPlaintext)

    // Step 5: commit, releasing the lease atomically.
    await ctx.runMutation(internal.subscriptions.mutations.commitRefreshedTokens, {
      subId,
      holderToken,
      ciphertext,
      nonce,
      keyVersion,
      expiresAt: nowMs + result.expiresIn * 1000,
      lastRefreshedAt: nowMs,
    })

    await ctx.runMutation(internal.refreshLog.mutations.insert, {
      userId: sub.userId,
      subscriptionId: subId,
      triggeredBy,
      outcome: 'success',
      at: nowMs,
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
      plaintext = decrypt(sub.ciphertext, sub.nonce, sub.keyVersion)
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
    // Fetch succeeded (result.ok). Map each window's parse outcome:
    //   - a live bucket   → active usage `{ pct, resetsAt, fetchedAt }`
    //   - 'absent'        → idle marker: the window genuinely has no active
    //                       limit (e.g. a 5h window that crossed its reset),
    //                       so REPLACE any stale value → dashboard shows "Ready".
    //   - 'invalid'       → the key was present but unparseable (payload drift).
    //                       Return `undefined` so patchUsage PRESERVES last-known
    //                       — never claim "Ready" / erase a real window on a
    //                       parse anomaly. Log it so the drift is visible.
    // Failed fetches returned early above, leaving last-known untouched.
    const toUsage = (bucket: typeof result.fiveHour, label: string) => {
      if (bucket === 'invalid') {
        console.error(
          `[cvault] fetchUsageForSub: ${label} usage bucket present but unparseable for subId ${subId}; preserving last-known`
        )
        return undefined
      }
      if (bucket === 'absent') return { idle: true as const, fetchedAt }
      return { pct: bucket.pct, resetsAt: bucket.resetsAtMs, fetchedAt }
    }
    await ctx.runMutation(internal.subscriptions.mutations.patchUsage, {
      subId,
      usage5h: toUsage(result.fiveHour, '5h'),
      usage7d: toUsage(result.sevenDay, '7d'),
    })
    return null
  },
})
