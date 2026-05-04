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
      const domains = await ctx.runQuery(internal.allowedDomains.queries.loadInternal, {})
      if (!isAllowedEmail(email, domains)) {
        const userId = data.id
        const result = await deleteClerkUser(userId)
        if (!result.ok) {
          console.error(
            `domainGate: BAPI delete failed for ${userId} (${email ?? '<missing>'}) — status=${String(result.status)}, body=${result.body.slice(0, 200)}`
          )
          return new Response('clerk delete failed', { status: 500 })
        }
        await ctx.runMutation(internal.users.actions.remove, { clerkUserId: userId })
        console.warn(`domainGate: rejected ${userId} (${email ?? '<missing>'}) — deleted via BAPI`)
        return new Response(null, { status: 200 })
      }
      await ctx.runMutation(internal.users.actions.upsert, { data })
      break
    }

    case 'user.deleted': {
      const clerkUserId = event.data.id!
      await ctx.runMutation(internal.users.actions.remove, { clerkUserId })
      break
    }

    default:
      console.log('Ignored Clerk webhook event', event.type)
  }

  return new Response(null, { status: 200 })
})
