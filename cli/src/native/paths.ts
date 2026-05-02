/**
 * Path resolution for Claude Code's config + credentials files.
 *
 * Mirrors `claude-swap/paths.py` exactly — the on-disk layout is shared
 * with Claude Code itself, so cvault must read/write the same paths to
 * stay interoperable.
 *
 * Key rules (sourced from claude-code's `utils/env.ts:getGlobalClaudeFile`):
 * - Config home: `$CLAUDE_CONFIG_DIR` if set, else `$HOME/.claude`.
 * - Global config: `<config_home>/.config.json` if it exists (legacy),
 *   else `($CLAUDE_CONFIG_DIR || $HOME)/.claude.json`. Note the asymmetry:
 *   `.claude.json` defaults to homedir, NOT inside `.claude/`.
 * - Credentials: `<config_home>/.credentials.json` (Linux/WSL only;
 *   macOS uses Keychain, see `keychain.ts`).
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve `$CLAUDE_CONFIG_DIR || $HOME/.claude`. */
export function getClaudeConfigHome(): string {
  const env = process.env.CLAUDE_CONFIG_DIR
  if (env !== undefined && env.length > 0) return env
  const home = process.env.HOME ?? homedir()
  return join(home, '.claude')
}

/**
 * Resolve the global Claude config file. Returns the legacy
 * `<config_home>/.config.json` if it exists, else
 * `($CLAUDE_CONFIG_DIR || $HOME)/.claude.json`.
 */
export function getGlobalConfigPath(): string {
  const legacy = join(getClaudeConfigHome(), '.config.json')
  if (existsSync(legacy)) return legacy

  const env = process.env.CLAUDE_CONFIG_DIR
  const base = env !== undefined && env.length > 0 ? env : (process.env.HOME ?? homedir())
  return join(base, '.claude.json')
}

/**
 * Resolve the Linux/WSL plaintext credentials file path.
 *
 * On macOS this path is unused — credentials live in Keychain. The function
 * still returns the value so callers that pre-compute paths don't need a
 * platform check; the keychain module is the actual macOS authority.
 */
export function getCredentialsFilePath(): string {
  return join(getClaudeConfigHome(), '.credentials.json')
}
