/**
 * `cvault refresh [slot|email]` — manually trigger a server-side OAuth
 * refresh.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7.
 *
 * Use cases:
 *   - User suspects their access token is dead before the cron picks it up
 *   - Diagnostic: confirm the refresh path works for a specific sub
 *
 * The backend exposes `api.subscriptions.actions.requestRefresh({subId})`
 * (an `authenticatedAction` that re-verifies ownership before running the
 * internal refresh). The CLI takes a slot or email; we resolve it to a
 * `subId` via `listForUser` first, then call the action.
 */
import { api } from '@cvault/convex/api'
import type { Id } from '@cvault/convex/dataModel'
import { defineCommand } from 'citty'

import { makeVaultClient } from '../convex/vaultClient'

export interface RunRefreshOptions {
  slotOrEmail: string
}

export async function runRefresh(opts: RunRefreshOptions): Promise<void> {
  const client = await makeVaultClient()

  // Resolve slot|email -> subId. We use `listForUser` because it's the same
  // surface every other CLI command uses to enumerate subs, so cache reuse
  // by Convex's HTTP layer is implicit.
  const subs = await client.query(api.subscriptions.queries.listForUser, {})

  const asNum = Number.parseInt(opts.slotOrEmail, 10)
  const isSlot = !Number.isNaN(asNum) && asNum.toString() === opts.slotOrEmail

  const found = isSlot ? subs.find((s) => s.slot === asNum) : subs.find((s) => s.email === opts.slotOrEmail)

  if (!found) {
    throw new Error(`No subscription matching ${opts.slotOrEmail}. Run \`cvault list\` to see available subscriptions.`)
  }

  await client.action(api.subscriptions.actions.requestRefresh, {
    subId: found._id as Id<'subscriptions'>,
  })
  console.log(`Refresh triggered for ${found.email} (slot ${String(found.slot)}).`)
}

export const refreshCommand = defineCommand({
  meta: {
    name: 'refresh',
    description: 'Force a server-side OAuth token refresh for one subscription.',
  },
  args: {
    target: {
      type: 'positional',
      description: 'Slot number or email to refresh.',
      required: true,
    },
  },
  async run({ args }) {
    await runRefresh({ slotOrEmail: args.target })
  },
})
