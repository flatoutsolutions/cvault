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

    case 'organization.created':
    // intentional fallthrough
    case 'organization.updated':
      await ctx.runMutation(internal.organizations.actions.upsert, {
        data: event.data,
      })
      break

    case 'organization.deleted': {
      const clerkOrgId = event.data.id!
      await ctx.runMutation(internal.organizations.actions.remove, {
        clerkOrgId,
      })
      break
    }

    case 'organizationMembership.created':
    // intentional fallthrough
    case 'organizationMembership.updated':
      await ctx.runMutation(internal.organizationMembers.actions.upsert, {
        data: event.data,
      })
      break

    case 'organizationMembership.deleted':
      await ctx.runMutation(internal.organizationMembers.actions.remove, {
        data: event.data,
      })
      break

    default:
      console.log('Ignored Clerk webhook event', event.type)
  }

  return new Response(null, { status: 200 })
})
