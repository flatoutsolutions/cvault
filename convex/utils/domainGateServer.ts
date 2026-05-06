import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import type { DataModel } from '../_generated/dataModel'
import { BOOTSTRAP_ALLOWED_DOMAINS, BOOTSTRAP_ALLOWED_EMAILS } from './domainGate'

export async function loadAllowedDomains(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
): Promise<string[]> {
  const rows = await ctx.db.query('allowedEmailDomains').collect()
  if (rows.length === 0) return [...BOOTSTRAP_ALLOWED_DOMAINS]
  return rows.map((r) => r.domain.toLowerCase())
}

export async function loadAllowedEmails(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
): Promise<string[]> {
  const rows = await ctx.db.query('allowedEmails').collect()
  if (rows.length === 0) return [...BOOTSTRAP_ALLOWED_EMAILS]
  return rows.map((r) => r.email.toLowerCase())
}
