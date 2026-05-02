/**
 * Helpers for round-tripping a single account between the Convex vault and
 * `claude-swap`. The CLI sends an opaque `plaintextBlob` to Convex on
 * `cvault add` (encrypted server-side under VAULT_AES_KEY) and receives it
 * back on `cvault switch` / `cvault sync`. claude-swap requires a specific
 * envelope shape for `--import`; this module is the single source of
 * truth for the round-trip.
 *
 * IMPORTANT: claude-swap's `--import` requires both `credentials` and
 * `config` on each account to be JSON objects, not strings or null. We
 * default `config` to `{}` for legacy uploads that did not capture it.
 */
import type { ClaudeSwapEnvelope } from './claudeSwap'

/**
 * Shape of the plaintext JSON blob we serialize into Convex for one
 * subscription. The `claudeAiOauth` object is required (it carries the
 * tokens). Everything else is metadata captured from the source envelope
 * so the destination machine can reconstruct an envelope claude-swap
 * accepts.
 */
export interface CvaultPlaintextBlob {
  claudeAiOauth: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    scopes: string[]
    subscriptionType: 'max' | 'pro'
  }
  config?: { oauthAccount?: Record<string, unknown> } | Record<string, unknown>
  uuid?: string
  organizationUuid?: string
  organizationName?: string
}

interface PullResult {
  email: string
  slot: number
  plaintextBlob: string
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Wrap a single-account plaintext blob into a `claude-swap --import`
 * envelope. `pull.plaintextBlob` must be a JSON string matching
 * `CvaultPlaintextBlob`; legacy blobs that only contain `claudeAiOauth`
 * still work — missing fields fall back to safe defaults.
 */
export function buildSingleAccountEnvelope(pull: PullResult): ClaudeSwapEnvelope {
  const blob = JSON.parse(pull.plaintextBlob) as CvaultPlaintextBlob
  const account: ClaudeSwapEnvelope['accounts'][number] = {
    number: pull.slot,
    email: pull.email,
    uuid: blob.uuid ?? ZERO_UUID,
    added: new Date().toISOString(),
    credentials: { claudeAiOauth: blob.claudeAiOauth },
    config: (blob.config ?? {}) as ClaudeSwapEnvelope['accounts'][number]['config'],
  }
  if (blob.organizationUuid !== undefined) account.organizationUuid = blob.organizationUuid
  if (blob.organizationName !== undefined) account.organizationName = blob.organizationName
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedFrom: 'cvault',
    swapVersion: 'cvault-managed',
    encrypted: false,
    activeAccountNumber: pull.slot,
    accounts: [account],
  }
}
