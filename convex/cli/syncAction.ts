'use node'

/**
 * Internal Node action that returns the full plaintext bundle for the
 * caller's active subs. Called by the public `/api/cli/sync` HTTP route
 * after that route has verified the Clerk JWT.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5 (HTTP) + §7.
 */
import { v } from 'convex/values'

import { internal } from '../_generated/api'
import { internalAction } from '../_generated/server'
import { decrypt } from '../subscriptions/crypto'

const subBundleEntryValidator = v.object({
  subId: v.id('subscriptions'),
  email: v.string(),
  slot: v.number(),
  label: v.optional(v.string()),
  plaintextBlob: v.string(),
  contentHash: v.string(),
})

async function sha256Hex(input: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(input).digest('hex')
}

interface BundleEntry {
  subId: import('../_generated/dataModel').Id<'subscriptions'>
  email: string
  slot: number
  label?: string
  plaintextBlob: string
  contentHash: string
}

export const buildBundleForUser = internalAction({
  args: { externalId: v.string() },
  returns: v.object({ subs: v.array(subBundleEntryValidator) }),
  handler: async (ctx, { externalId }): Promise<{ subs: Array<BundleEntry> }> => {
    const subs = await ctx.runQuery(internal.cli.internalReads.listSubsRawForUser, { externalId })

    const out: Array<BundleEntry> = await Promise.all(
      subs.map(async (s): Promise<BundleEntry> => {
        const plaintextBlob = decrypt(s.ciphertext, s.nonce, s.keyVersion)
        const contentHash = await sha256Hex(plaintextBlob)
        return {
          subId: s._id,
          email: s.email,
          slot: s.slot,
          label: s.label,
          plaintextBlob,
          contentHash,
        }
      })
    )

    return { subs: out }
  },
})
