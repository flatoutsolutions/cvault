/**
 * Read/merge/write `~/.claude/settings.json` to install or remove the
 * cvault `UserPromptSubmit` hook (`cvault pull`). Claude Code reads this
 * file on every invocation and runs the hook synchronously before the
 * prompt is processed, so `cvault pull` keeps the keychain fresh and a
 * running `claude` re-reads it on token expiry.
 *
 * Writes go through the shared `~/.claude` lock so we never race Claude
 * Code's own writes to that directory.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { withFileLock } from './lock'
import { getClaudeConfigHome } from './paths'

export interface HookCommand {
  type: string
  command: string
  async?: boolean
}
export interface HookGroup {
  matcher?: string
  hooks: HookCommand[]
}
export interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>
  [k: string]: unknown
}

export function settingsPath(): string {
  return join(getClaudeConfigHome(), 'settings.json')
}

export function readSettings(): ClaudeSettings {
  const path = settingsPath()
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw) as ClaudeSettings
  } catch (err) {
    // A raw SyntaxError tells the user nothing actionable. Name the file and
    // the fix — a malformed settings.json otherwise silently disables the
    // pull hook (install/uninstall both throw before touching it).
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`${path} is not valid JSON (${detail}). Fix it by hand, then re-run.`)
  }
}

/** Pure: append a synchronous UserPromptSubmit hook unless it already exists. */
export function addUserPromptSubmitHook(settings: ClaudeSettings, command: string): ClaudeSettings {
  const hooks = settings.hooks ?? {}
  const existing = hooks.UserPromptSubmit ?? []
  const alreadyPresent = existing.some((g) => g.hooks.some((h) => h.command === command))
  if (alreadyPresent) return settings
  const group: HookGroup = { hooks: [{ type: 'command', command }] }
  return { ...settings, hooks: { ...hooks, UserPromptSubmit: [...existing, group] } }
}

/** Pure: remove our command; drop the UserPromptSubmit key if it becomes empty. */
export function removeUserPromptSubmitHook(settings: ClaudeSettings, command: string): ClaudeSettings {
  const hooks = settings.hooks
  if (!hooks?.UserPromptSubmit) return settings
  const kept = hooks.UserPromptSubmit.map((g) => ({
    ...g,
    hooks: g.hooks.filter((h) => h.command !== command),
  })).filter((g) => g.hooks.length > 0)
  const nextHooks: Record<string, HookGroup[]> = { ...hooks }
  if (kept.length > 0) nextHooks.UserPromptSubmit = kept
  else delete nextHooks.UserPromptSubmit
  return { ...settings, hooks: nextHooks }
}

function writeSettings(settings: ClaudeSettings): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n')
}

export async function installPullHook(command: string): Promise<void> {
  await withFileLock(() => {
    writeSettings(addUserPromptSubmitHook(readSettings(), command))
  })
}

export async function uninstallPullHook(command: string): Promise<void> {
  await withFileLock(() => {
    writeSettings(removeUserPromptSubmitHook(readSettings(), command))
  })
}
