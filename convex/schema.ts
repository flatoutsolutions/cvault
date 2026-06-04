import { defineSchema } from 'convex/server'

import { allowedEmailDomainsSchema } from './allowedDomains/schema'
import { allowedEmailsSchema } from './allowedEmails/schema'
import { devicesSchema } from './devices/schema'
import { keyRotationJobsSchema } from './keyRotationJobs/schema'
import { machineActivitySchema } from './machineActivity/schema'
import { rateLimitSchema } from './rateLimit/schema'
import { refreshLogSchema } from './refreshLog/schema'
import { revokedSessionsSchema } from './revokedSessions/schema'
import { revokedUsersSchema } from './revokedUsers/schema'
import { subscriptionsSchema } from './subscriptions/schema'
import { usersSchema } from './users/schema'

export default defineSchema({
  allowedEmailDomains: allowedEmailDomainsSchema,
  allowedEmails: allowedEmailsSchema,
  devices: devicesSchema,
  keyRotationJobs: keyRotationJobsSchema,
  machineActivity: machineActivitySchema,
  rateLimit: rateLimitSchema,
  refreshLog: refreshLogSchema,
  revokedSessions: revokedSessionsSchema,
  revokedUsers: revokedUsersSchema,
  subscriptions: subscriptionsSchema,
  users: usersSchema,
})
