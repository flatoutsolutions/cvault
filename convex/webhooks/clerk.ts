'use node'

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
    // intentional fallthrough
    case 'user.updated': {
      const data = event.data
      const email = primaryEmailFromUserJSON(data)
      if (!isAllowedEmail(email)) {
        // Disallowed domain. Nuke via BAPI + remove any orphan users row.
        const userId = data.id
        const result = await deleteClerkUser(userId)
        if (!result.ok) {
          // 5xx from Clerk — return 500 so Clerk retries the webhook later.
          // (404 was treated as success inside deleteClerkUser.)
          console.error(
            `domainGate: BAPI delete failed for ${userId} (${data.email_addresses
              .map((e) => e.email_address)
              .join(',')}) — status=${String(result.status)}, body=${result.body.slice(0, 200)}`
          )
          return new Response('clerk delete failed', { status: 500 })
        }
        // Belt-and-braces: clear any orphan users row that may exist from a
        // prior allowed state (rare — only happens if the user changed their
        // primary email after signup).
        await ctx.runMutation(internal.users.actions.remove, { clerkUserId: userId })
        console.warn(`domainGate: rejected ${userId} primary email ${email ?? '<missing>'} — deleted via BAPI`)
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
