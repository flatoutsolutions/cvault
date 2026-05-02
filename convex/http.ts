import { httpRouter } from 'convex/server'

import { cliMintHandler } from './cli/httpMint'
import { cliSyncHandler } from './cli/httpSync'
import { clerkUsersWebhook } from './webhooks/clerk'

const http = httpRouter()

http.route({
  path: '/webhooks/clerk',
  method: 'POST',
  handler: clerkUsersWebhook,
})

http.route({
  path: '/api/cli/sync',
  method: 'GET',
  handler: cliSyncHandler,
})

http.route({
  path: '/api/cli/mint-token',
  method: 'POST',
  handler: cliMintHandler,
})

export default http
