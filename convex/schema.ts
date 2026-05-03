import { defineSchema } from 'convex/server'

import { machineActivitySchema } from './machineActivity/schema'
import { organizationMembersSchema } from './organizationMembers/schema'
import { organizationsSchema } from './organizations/schema'
import { rateLimitSchema } from './rateLimit/schema'
import { refreshLogSchema } from './refreshLog/schema'
import { subscriptionsSchema } from './subscriptions/schema'
import { usersSchema } from './users/schema'

export default defineSchema({
  machineActivity: machineActivitySchema,
  organizationMembers: organizationMembersSchema,
  organizations: organizationsSchema,
  rateLimit: rateLimitSchema,
  refreshLog: refreshLogSchema,
  subscriptions: subscriptionsSchema,
  users: usersSchema,
})
