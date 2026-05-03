import { internal } from '../_generated/api'
import { httpAction } from '../_generated/server'
import { validateRequest } from '../utils/validateRequest'

export const clerkUsersWebhook = httpAction(async (ctx, request) => {
  const event = await validateRequest(request)
  if (!event) {
    return new Response('Invalid webhook signature', { status: 400 })
  }

  switch (event.type) {
    case 'user.created':
    // intentional fallthrough
    case 'user.updated':
      await ctx.runMutation(internal.users.actions.upsert, {
        data: event.data,
      })
      break

    case 'user.deleted': {
      const clerkUserId = event.data.id!
      await ctx.runMutation(internal.users.actions.remove, {
        clerkUserId,
      })
      break
    }

    default:
      console.log('Ignored Clerk webhook event', event.type)
  }

  return new Response(null, { status: 200 })
})
