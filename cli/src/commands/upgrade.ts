/**
 * `cvault upgrade` — self-update via Homebrew.
 *
 * Thin wrapper over `native/brew.upgradeCvault`, which runs
 * `brew update && brew upgrade flatoutsolutions/cvault/cvault`. The
 * explicit `brew update` is the important part: it forces a tap refresh so
 * a freshly-released formula is actually seen, instead of Homebrew
 * reporting the installed version as "already" newest from a stale tap.
 * See `native/brew.ts` for the full rationale.
 */
import { defineCommand } from 'citty'

import { upgradeCvault } from '../native/brew'

export async function runUpgrade(): Promise<void> {
  await upgradeCvault()
  console.log('\ncvault is up to date.')
}

export const upgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    description: 'Update Homebrew and upgrade cvault to the latest release.',
  },
  async run() {
    await runUpgrade()
  },
})
