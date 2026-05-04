import { defineSchema } from 'convex/server'

import { allowedEmailDomainsSchema } from './allowedDomains/schema'
import { keyRotationJobsSchema } from './keyRotationJobs/schema'
import { machineActivitySchema } from './machineActivity/schema'
import { rateLimitSchema } from './rateLimit/schema'
import { refreshLogSchema } from './refreshLog/schema'
import { subscriptionsSchema } from './subscriptions/schema'
import { usersSchema } from './users/schema'

export default defineSchema({
  allowedEmailDomains: allowedEmailDomainsSchema,
  keyRotationJobs: keyRotationJobsSchema,
  machineActivity: machineActivitySchema,
  rateLimit: rateLimitSchema,
  refreshLog: refreshLogSchema,
  subscriptions: subscriptionsSchema,
  users: usersSchema,
})
