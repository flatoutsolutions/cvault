/**
 * Authenticated Convex function wrappers.
 *
 *  1. Verify ctx.auth.getUserIdentity() is non-null.
 *  2. Load runtime allowlist (allowedEmailDomains table or BOOTSTRAP).
 *  3. Verify identity.email is on the allowlist.
 *  4. Pass UserIdentity through as ctx.identity.
 *
 * Spec: docs/superpowers/specs/2026-05-04-flatout-domain-only-design.md §3.4
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
import { ConvexError, type PropertyValidators } from 'convex/values'

import type { DataModel } from '../_generated/dataModel'
import { internal } from '../_generated/api'
import { action, mutation, query } from '../_generated/server'
import { DOMAIN_REJECTION_ERROR_CODE, DOMAIN_REJECTION_MESSAGE, isAllowedEmail } from './domainGate'
import { loadAllowedDomainsFromAction, loadAllowedEmailsFromAction } from './domainGateAction'
import { loadAllowedDomains, loadAllowedEmails } from './domainGateServer'

/**
 * Throwing a plain `Error` from a public function surfaces on the client
 * as the generic masked string `"Server Error"` (Convex strips the message
 * to avoid leaking internals from prod). For "Not authenticated" we'd
 * rather the dashboard see a real, structured code so it can render an
 * actionable message instead of a baffling "Server Error" toast.
 */
function notAuthenticatedError(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: 'NOT_AUTHENTICATED',
    message: 'Not authenticated. Sign in again before retrying.',
  })
}

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

function rejectDomain(): never {
  throw new ConvexError({
    code: DOMAIN_REJECTION_ERROR_CODE,
    message: DOMAIN_REJECTION_MESSAGE,
  })
}

function rejectRevoked(): never {
  throw new ConvexError({ code: 'USER_REVOKED', message: 'Access revoked. Contact an administrator.' })
}

async function assertNotRevoked(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel> | GenericActionCtx<DataModel>,
  subject: string
): Promise<void> {
  const isRevoked =
    'runQuery' in ctx
      ? await (ctx as GenericActionCtx<DataModel>).runQuery(internal.revokedUsers.queries.isRevoked, {
          externalId: subject,
        })
      : await (ctx as GenericQueryCtx<DataModel>).db
          .query('revokedUsers')
          .withIndex('byExternalId', (q) => q.eq('externalId', subject))
          .unique()
          .then((r) => r !== null)
  if (isRevoked) rejectRevoked()
}

async function resolveServer(ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw notAuthenticatedError()
  await assertNotRevoked(ctx, identity.subject)
  // Load both lists in parallel — they hit independent tables and the
  // gate only needs both to make a decision.
  const [domains, emails] = await Promise.all([loadAllowedDomains(ctx), loadAllowedEmails(ctx)])
  if (!isAllowedEmail(typeof identity.email === 'string' ? identity.email : null, domains, emails)) {
    rejectDomain()
  }
  return identity
}

async function resolveAction(ctx: GenericActionCtx<DataModel>): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw notAuthenticatedError()
  await assertNotRevoked(ctx, identity.subject)
  const [domains, emails] = await Promise.all([loadAllowedDomainsFromAction(ctx), loadAllowedEmailsFromAction(ctx)])
  if (!isAllowedEmail(typeof identity.email === 'string' ? identity.email : null, domains, emails)) {
    rejectDomain()
  }
  return identity
}

export const authenticatedQuery = (<Args extends DefaultFunctionArgs>(fn: {
  args?: PropertyValidators
  returns?: import('convex/values').Validator<unknown>
  handler: (ctx: GenericQueryCtx<DataModel>, args: Args) => Promise<unknown>
}) => {
  return query({
    args: fn.args ?? {},
    ...(fn.returns !== undefined ? { returns: fn.returns } : {}),
    handler: async (ctx, args) => {
      const identity = await resolveServer(ctx)
      return await fn.handler(Object.assign(ctx, { identity }), args as Args)
    },
  })
}) as QueryBuilder<DataModel, 'public'>

export const authenticatedMutation = (<Args extends DefaultFunctionArgs>(fn: {
  args?: PropertyValidators
  returns?: import('convex/values').Validator<unknown>
  handler: (ctx: GenericMutationCtx<DataModel>, args: Args) => Promise<unknown>
}) => {
  return mutation({
    args: fn.args ?? {},
    ...(fn.returns !== undefined ? { returns: fn.returns } : {}),
    handler: async (ctx, args) => {
      const identity = await resolveServer(ctx)
      return await fn.handler(Object.assign(ctx, { identity }), args as Args)
    },
  })
}) as MutationBuilder<DataModel, 'public'>

export const authenticatedAction = (<Args extends DefaultFunctionArgs>(fn: {
  args?: PropertyValidators
  returns?: import('convex/values').Validator<unknown>
  handler: (ctx: GenericActionCtx<DataModel>, args: Args) => Promise<unknown>
}) => {
  return action({
    args: fn.args ?? {},
    ...(fn.returns !== undefined ? { returns: fn.returns } : {}),
    handler: async (ctx, args) => {
      const identity = await resolveAction(ctx)
      return await fn.handler(Object.assign(ctx, { identity }), args as Args)
    },
  })
}) as ActionBuilder<DataModel, 'public'>
