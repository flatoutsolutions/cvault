/**
 * Authenticated Convex function wrappers.
 *
 * These wrap `query` / `mutation` / `action` and:
 *  1. Verify `ctx.auth.getUserIdentity()` is non-null (else throw).
 *  2. Pass the verified `UserIdentity` as `ctx.identity`.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5 + §8 + §12.
 *
 * USAGE
 * -----
 * Inside an authenticated handler, read the identity via `getIdentity(ctx)`
 * (NOT `ctx.identity` — the runtime augmentation is invisible to TS through
 * the registered-function cast, but `getIdentity` re-asserts it safely):
 *
 * ```ts
 * export const myQuery = authenticatedQuery({
 *   args: {},
 *   handler: async (ctx) => {
 *     const identity = getIdentity(ctx)
 *     return identity.subject
 *   },
 * })
 * ```
 */
import {
  type ActionBuilder,
  type DefaultFunctionArgs,
  type GenericActionCtx,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type MutationBuilder,
  type QueryBuilder,
  type UserIdentity,
} from 'convex/server'
import type { PropertyValidators } from 'convex/values'

import type { DataModel } from '../_generated/dataModel'
import { action, mutation, query } from '../_generated/server'

/**
 * Read the verified Clerk identity from a ctx that has been augmented by
 * one of the `authenticated*` wrappers.
 *
 * Throws if called from a ctx that wasn't routed through a wrapper (i.e.
 * `identity` was never attached). This indicates a programming error —
 * use the appropriate wrapper instead of calling `getIdentity` from a
 * plain `query`/`mutation`/`action`.
 */
export function getIdentity(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel> | GenericActionCtx<DataModel>
): UserIdentity {
  const augmented = ctx as { identity?: unknown }
  const id = augmented.identity
  if (!id || typeof id !== 'object') {
    throw new Error('getIdentity called on a non-authenticated ctx. Use authenticatedQuery/Mutation/Action.')
  }
  // We trust the wrapper attached the same shape Convex returned from
  // ctx.auth.getUserIdentity(). The `subject`/`issuer`/`tokenIdentifier`
  // tests are belt-and-braces.
  const candidate = id as Record<string, unknown>
  if (
    typeof candidate.subject !== 'string' ||
    typeof candidate.issuer !== 'string' ||
    typeof candidate.tokenIdentifier !== 'string'
  ) {
    throw new Error('Augmented identity is malformed')
  }
  return id as UserIdentity
}

/**
 * Like `query`, but ensures the caller is authenticated.
 */
export const authenticatedQuery = (<Args extends DefaultFunctionArgs>(fn: {
  args?: PropertyValidators
  returns?: import('convex/values').Validator<unknown>
  handler: (ctx: GenericQueryCtx<DataModel>, args: Args) => Promise<unknown>
}) => {
  return query({
    args: fn.args ?? {},
    ...(fn.returns !== undefined ? { returns: fn.returns } : {}),
    handler: async (ctx, args) => {
      const identity = await ctx.auth.getUserIdentity()
      if (!identity) {
        throw new Error('Not authenticated')
      }
      return await fn.handler(Object.assign(ctx, { identity }), args as Args)
    },
  })
}) as QueryBuilder<DataModel, 'public'>

/**
 * Like `mutation`, but ensures the caller is authenticated.
 */
export const authenticatedMutation = (<Args extends DefaultFunctionArgs>(fn: {
  args?: PropertyValidators
  returns?: import('convex/values').Validator<unknown>
  handler: (ctx: GenericMutationCtx<DataModel>, args: Args) => Promise<unknown>
}) => {
  return mutation({
    args: fn.args ?? {},
    ...(fn.returns !== undefined ? { returns: fn.returns } : {}),
    handler: async (ctx, args) => {
      const identity = await ctx.auth.getUserIdentity()
      if (!identity) {
        throw new Error('Not authenticated')
      }
      return await fn.handler(Object.assign(ctx, { identity }), args as Args)
    },
  })
}) as MutationBuilder<DataModel, 'public'>

/**
 * Like `action`, but ensures the caller is authenticated.
 */
export const authenticatedAction = (<Args extends DefaultFunctionArgs>(fn: {
  args?: PropertyValidators
  returns?: import('convex/values').Validator<unknown>
  handler: (ctx: GenericActionCtx<DataModel>, args: Args) => Promise<unknown>
}) => {
  return action({
    args: fn.args ?? {},
    ...(fn.returns !== undefined ? { returns: fn.returns } : {}),
    handler: async (ctx, args) => {
      const identity = await ctx.auth.getUserIdentity()
      if (!identity) {
        throw new Error('Not authenticated')
      }
      return await fn.handler(Object.assign(ctx, { identity }), args as Args)
    },
  })
}) as ActionBuilder<DataModel, 'public'>
