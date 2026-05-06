import type { GenericActionCtx } from 'convex/server'

import { internal } from '../_generated/api'
import type { DataModel } from '../_generated/dataModel'

export async function loadAllowedDomainsFromAction(ctx: GenericActionCtx<DataModel>): Promise<string[]> {
  return await ctx.runQuery(internal.allowedDomains.queries.loadInternal, {})
}

export async function loadAllowedEmailsFromAction(ctx: GenericActionCtx<DataModel>): Promise<string[]> {
  return await ctx.runQuery(internal.allowedEmails.queries.loadInternal, {})
}
