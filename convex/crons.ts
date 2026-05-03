/**
 * cvault cron schedule.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5.
 *
 * - refreshExpiringTokens: every 10 minutes — scans the byExpiry index for
 *   tokens expiring inside the next 15 minutes and rotates each.
 * - pollUsage: every 5 minutes — fans out a usage fetch per active sub.
 *
 * Both worker actions are internalActions so they cannot be triggered
 * from the public client.
 */
import { cronJobs } from 'convex/server'

import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval('refresh expiring oauth tokens', { minutes: 10 }, internal.subscriptions.crons.refreshExpiringTokens, {})

crons.interval('poll anthropic usage', { minutes: 5 }, internal.subscriptions.crons.pollUsage, {})

export default crons
