/**
 * Shared helpers for Convex-edge scenario tests.
 *
 * These are scenario-only sugar over the existing harness in
 * `convex/__tests__/helpers.ts`. They are not exercised by unit tests of
 * their own — the scenarios that import them are themselves the
 * verification.
 *
 * Plan: docs/research/scenario-tests-plan.md §3 (the convex-edge half).
 */
import { type Mock, vi } from 'vitest'

import { api } from '../_generated/api'
import { type Id } from '../_generated/dataModel'
import { type TEST_IDENTITY, vault } from '../__tests__/helpers'

// ---------------------------------------------------------------------------
// Plaintext / encryption helpers
// ---------------------------------------------------------------------------

/**
 * Build a deterministic OAuth blob shaped like what claude-swap stores.
 * `accessToken` and `refreshToken` are intentionally not real Anthropic
 * tokens — they only need to:
 *   - look enough like the real shape that token redaction can fire
 *   - be distinguishable across iterations in race tests
 */
export function buildOauthBlob(opts: {
  accessSuffix?: string
  refreshSuffix?: string
  expiresAt: number
}): string {
  const accessSuffix = opts.accessSuffix ?? 'INITIAL-AAAAAAAAAAAAAAAAAAAAAAAA'
  const refreshSuffix = opts.refreshSuffix ?? 'INITIAL-BBBBBBBBBBBBBBBBBBBBBBBB'
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat01-${accessSuffix}`,
      refreshToken: `sk-ant-ort01-${refreshSuffix}`,
      expiresAt: opts.expiresAt,
      scopes: ['user:inference'],
    },
  })
}

/**
 * Seed an authenticated user + a single subscription whose plaintext blob
 * encrypts to fresh ciphertext+nonce.
 *
 * Returns the subId/userId tuple plus the original blob string for tests
 * that want to assert on the pre-refresh content.
 */
export async function seedSubscription(opts: {
  t: ReturnType<typeof vault>
  identity: typeof TEST_IDENTITY
  email: string
  expiresAt: number
  refreshExpiresAt?: number
  label?: string
  blob?: string
}): Promise<{
  subId: Id<'subscriptions'>
  userId: Id<'users'>
  slot: number
  blob: string
}> {
  const { t, identity, email, expiresAt, refreshExpiresAt, label } = opts
  const blob = opts.blob ?? buildOauthBlob({ expiresAt })

  // Insert the user row directly. We can't use seedUser() here because the
  // caller may pass a custom identity and we want a single helper call.
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query('users')
      .withIndex('byExternalId', (q) => q.eq('externalId', identity.subject))
      .unique()
    if (existing) return
    await ctx.db.insert('users', {
      externalId: identity.subject,
      name: identity.name,
      primaryEmail: identity.email,
      otherEmails: [],
    })
  })

  const { encrypt } = await import('../subscriptions/crypto')
  const { ciphertext, nonce } = encrypt(blob)

  const inserted = await t
    .withIdentity(identity)
    .mutation(api.subscriptions.mutations.upsert, {
      email,
      ciphertext,
      nonce,
      expiresAt,
      refreshExpiresAt,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
      label,
    })
  return {
    subId: inserted.subId,
    userId: inserted.userId,
    slot: inserted.slot,
    blob,
  }
}

// ---------------------------------------------------------------------------
// Anthropic fetch stub helpers
// ---------------------------------------------------------------------------

export interface AnthropicResponseSpec {
  status?: number
  body?: unknown
  /** Optional: raw text body (overrides `body` JSON encoding). */
  rawBody?: string
  /** Optional: response Content-Type. Defaults to application/json. */
  contentType?: string
}

/** Internal: build a Response from a spec. */
function responseFromSpec(spec: AnthropicResponseSpec): Response {
  const headers = { 'Content-Type': spec.contentType ?? 'application/json' }
  const body = spec.rawBody ?? JSON.stringify(spec.body ?? {})
  return new Response(body, { status: spec.status ?? 200, headers })
}

/**
 * Build a one-shot fetch stub that returns the supplied response. Caller
 * must install via `__setAnthropicFetch(stub)` and clean up in afterEach.
 *
 * The return type is `Mock<typeof fetch>` (not the looser `ReturnType<typeof
 * vi.fn>`) so it satisfies `__setAnthropicFetch`'s `typeof fetch | undefined`
 * parameter under strict TypeScript without an `as` cast.
 */
export function makeAnthropicFetchStub(spec: AnthropicResponseSpec): Mock<typeof fetch> {
  return vi.fn<typeof fetch>(() => Promise.resolve(responseFromSpec(spec)))
}

/**
 * Build a multi-call fetch stub whose Nth call returns specs[N]. After
 * the list is exhausted, subsequent calls reuse the last spec.
 */
export function makeAnthropicSequenceStub(
  specs: ReadonlyArray<AnthropicResponseSpec>
): Mock<typeof fetch> {
  let i = 0
  return vi.fn<typeof fetch>(() => {
    const spec = specs[Math.min(i, specs.length - 1)] ?? { status: 200, body: {} }
    i += 1
    return Promise.resolve(responseFromSpec(spec))
  })
}

// ---------------------------------------------------------------------------
// AES master-key helpers
// ---------------------------------------------------------------------------

export interface VaultKeyHandle {
  /** Restore the prior VAULT_AES_KEY (or unset it if none was set). */
  restore: () => void
}

/**
 * Set a deterministic VAULT_AES_KEY for the duration of a test.
 * Pass the byte fill value so different scenario files can use different
 * keys and still pass when run in parallel.
 */
export function withVaultKey(fillByte: number): VaultKeyHandle {
  const previous = process.env.VAULT_AES_KEY
  process.env.VAULT_AES_KEY = Buffer.alloc(32, fillByte).toString('base64')
  return {
    restore() {
      if (previous === undefined) {
        delete process.env.VAULT_AES_KEY
      } else {
        process.env.VAULT_AES_KEY = previous
      }
    },
  }
}
