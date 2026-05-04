/**
 * cvault cron schedule.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §5.
 *
 * - pollUsage: every 5 minutes — fans out a usage fetch per active sub.
 *   Read-only against Anthropic; no token rotation side effects.
 *
 * The worker action is `internalAction` so it cannot be triggered from
 * the public client.
 */
import { cronJobs } from 'convex/server'

import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval('poll anthropic usage', { minutes: 5 }, internal.subscriptions.crons.pollUsage, {})

export default crons
