/**
 * `cvault logout` — remove the claude `UserPromptSubmit` hook and delete the
 * persisted session. Inverse of `cvault login`.
 */
import { defineCommand } from 'citty'

import { deleteSession } from '../auth/session'
import { uninstallPullHook } from '../native/claudeSettings'
import { pullHookCommand } from './login'

export async function runLogout(): Promise<void> {
  // Best-effort hook removal: a malformed/unreadable settings.json must not
  // strand the user logged-in. Clearing the session is the part that matters.
  try {
    await uninstallPullHook(pullHookCommand())
  } catch (err) {
    console.warn('Could not remove the claude hook from settings.json:', err instanceof Error ? err.message : err)
  }
  await deleteSession()
  console.log('Signed out: removed the claude hook and cleared the local session.')
}

export const logoutCommand = defineCommand({
  meta: { name: 'logout', description: 'Remove the claude hook and clear the local cvault session.' },
  async run() {
    await runLogout()
  },
})
