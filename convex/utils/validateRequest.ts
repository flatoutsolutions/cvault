import type { WebhookEvent } from '@clerk/backend'
import { Webhook } from 'svix'

export async function validateRequest(req: Request) {
  const payloadString = await req.text()
  const svixHeaders = {
    'svix-id': req.headers.get('svix-id')!,
    'svix-timestamp': req.headers.get('svix-timestamp')!,
    'svix-signature': req.headers.get('svix-signature')!,
  }

  const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET!)
  try {
    return wh.verify(payloadString, svixHeaders) as WebhookEvent
  } catch (error) {
    console.error('Error verifying webhook event', error)
    return null
  }
}
