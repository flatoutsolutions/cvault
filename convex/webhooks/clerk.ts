import type { UserJSON } from '@clerk/backend'

import { internal } from '../_generated/api'
import { httpAction } from '../_generated/server'
import { deleteClerkUser } from '../cli/clerk'
import { isAllowedEmail } from '../utils/domainGate'
import { validateRequest } from '../utils/validateRequest'

function primaryEmailFromUserJSON(data: UserJSON): string | null {
  const primary = data.email_addresses.find((e) => e.id === data.primary_email_address_id)
  return primary?.email_address ?? null
}

export const clerkUsersWebhook = httpAction(async (ctx, request) => {
  const event = await validateRequest(request)
  if (!event) {
    return new Response('Invalid webhook signature', { status: 400 })
  }

  switch (event.type) {
    case 'user.created':
    case 'user.updated': {
      const data = event.data
      const email = primaryEmailFromUserJSON(data)
      // Load both allowlists in parallel — the gate only needs both to
      // make a decision and the queries hit independent tables.
      const [domains, emails] = await Promise.all([
        ctx.runQuery(internal.allowedDomains.queries.loadInternal, {}),
        ctx.runQuery(internal.allowedEmails.queries.loadInternal, {}),
      ])
      if (!isAllowedEmail(email, domains, emails)) {
        const userId = data.id
        // Multi-deployment safety: a single Clerk tenant can fan webhook
        // deliveries to multiple Convex deployment endpoints (e.g. prod +
        // a developer's dev deployment subscribed to the same Clerk
        // instance). Each deployment owns its own `allowedEmails` /
        // `allowedDomains` tables, so a personal address admitted by prod
        // is unknown to dev. If dev also ran the destructive BAPI DELETE
        // on rejection, it would race-destroy the Clerk user that prod
        // just admitted — locking the user out of prod too, because
        // Clerk users are tenant-global. Gate the destructive path
        // behind `ENVIRONMENT === 'production'` so only the canonical
        // deployment acts on rejection. Non-canonical deployments still
        // skip the upsert (no users row written) and return 200; the
        // DomainGuard frontend remains the runtime guardrail against
        // unauthorized UI access on those deployments.
        if (process.env.ENVIRONMENT === 'production') {
          const result = await deleteClerkUser(userId)
          if (!result.ok) {
            console.error(
              `domainGate: BAPI delete failed for ${userId} (${email ?? '<missing>'}) — status=${String(result.status)}, body=${result.body.slice(0, 200)}`
            )
            return new Response('clerk delete failed', { status: 500 })
          }
          await ctx.runMutation(internal.users.actions.remove, { clerkUserId: userId })
          console.warn(`domainGate: rejected ${userId} (${email ?? '<missing>'}) — deleted via BAPI`)
        } else {
          console.warn(
            `domainGate: rejected ${userId} (${email ?? '<missing>'}) on non-production deployment (ENVIRONMENT=${String(process.env.ENVIRONMENT)}); skipping BAPI delete + local remove to avoid destroying users authorized on the canonical deployment`
          )
        }
        return new Response(null, { status: 200 })
      }
      await ctx.runMutation(internal.users.actions.upsert, { data })
      break
    }

    case 'user.deleted': {
      // Clerk's `user.deleted` payload should always carry `data.id`, but
      // a malformed/forged Svix-passing payload could omit it. Per
      // project rule (no `!`, no `as any`): check + drop on missing.
      // Returning 200 means Svix won't retry — bad payloads are not
      // recoverable by retry, and looping on them is worse than dropping.
      const clerkUserId = event.data.id
      if (clerkUserId == null) {
        console.error(`clerk webhook: user.deleted event missing data.id — dropping payload`)
        return new Response(null, { status: 200 })
      }
      // Capture the users row BEFORE the delete so the audit row's
      // `userId` foreign key still resolves. Convex doesn't enforce FK
      // constraints, but recording the actual id (rather than a
      // sentinel) keeps the dashboard's per-user activity view coherent
      // for the deleted account.
      //
      // Order: capture → audit → delete. The audit row is written while
      // the user row still exists, so the FK target is valid at write
      // time. After the subsequent delete the FK is dangling, which is
      // standard audit-log semantics (the record of "this user was
      // removed" survives the user). The pre-fix order (delete first,
      // then audit) wrote the FK after its target had been removed —
      // functionally equivalent given Convex's lack of FK enforcement,
      // but the new order documents intent more clearly.
      const userRow = await ctx.runQuery(internal.users.actions.getIdByExternalId, {
        externalId: clerkUserId,
      })
      // Skip audit when there is no users row — domain-gate may have
      // already cleared an orphan during the create path; emitting an
      // audit row with a null userId would violate the schema validator.
      if (userRow !== null) {
        await ctx.runMutation(internal.machineActivity.mutations.record, {
          userId: userRow,
          // Sentinel — webhook events have no associated CLI session.
          clerkSessionId: 'webhook',
          action: 'remove',
          at: Date.now(),
        })
      }
      await ctx.runMutation(internal.users.actions.remove, { clerkUserId })
      break
    }

    default:
      console.log('Ignored Clerk webhook event', event.type)
  }

  return new Response(null, { status: 200 })
})
