/**
 * Internal mutation that records a row in the machineActivity audit log.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §4 + §6 + §12.
 *
 * SECURITY: any caller (action, internal mutation, or HTTP action) that
 * has access to the raw client IP passes it as `rawIp`. This mutation
 * hashes it via SHA-256 and stores only the first 8 hex chars. The
 * caller must NOT persist the raw IP anywhere else.
 *
 * Hashing uses Convex's V8-runtime `crypto.subtle` (Web Crypto API) so
 * this file can stay in the default V8 runtime alongside other mutations.
 */
import { v } from 'convex/values'

import { internalMutation } from '../_generated/server'

const actionLiteral = v.union(
  v.literal('switch'),
  v.literal('add'),
  v.literal('pull'),
  v.literal('remove'),
  v.literal('refresh'),
  v.literal('rename'),
  v.literal('login')
)

async function hashIp(rawIp: string): Promise<string> {
  const data = new TextEncoder().encode(rawIp)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  // Take the first 4 bytes -> 8 hex chars.
  let hex = ''
  for (const byte of bytes.slice(0, 4)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

export const record = internalMutation({
  args: {
    userId: v.id('users'),
    clerkSessionId: v.string(),
    action: actionLiteral,
    subscriptionId: v.optional(v.id('subscriptions')),
    at: v.number(),
    rawIp: v.optional(v.string()),
    /**
     * Human-readable identifier for the originating machine. See the
     * field's docstring in `schema.ts` for why this is optional.
     */
    machineLabel: v.optional(v.string()),
  },
  returns: v.id('machineActivity'),
  handler: async (ctx, args) => {
    const ipHash = args.rawIp !== undefined ? await hashIp(args.rawIp) : undefined

    return await ctx.db.insert('machineActivity', {
      userId: args.userId,
      clerkSessionId: args.clerkSessionId,
      action: args.action,
      subscriptionId: args.subscriptionId,
      at: args.at,
      ipHash,
      machineLabel: args.machineLabel,
    })
  },
})
