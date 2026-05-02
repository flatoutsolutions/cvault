/**
 * `addAccountInteractive` — drive the Claude Code OAuth flow so cvault
 * can capture the resulting credentials.
 *
 * Implementation: spawn `claude auth login` (NOT bare `claude`). The bare
 * command opens an interactive TUI session that does not trigger an OAuth
 * exchange — it just shows the chat UI; the user sees "Not logged in"
 * indefinitely. `claude auth login` is the documented entry point that
 * runs the OAuth flow end to end and exits 0 once credentials land in the
 * Keychain + `~/.claude.json` `oauthAccount`. cvault then reads both via
 * `buildEnvelope`.
 *
 * `stdio: 'inherit'` so the user sees the prompt and can paste the OAuth
 * code / press enter. No timeout — user controls when it finishes
 * (Ctrl-C aborts the spawn).
 */
import { ClaudeCliMissingError } from './errors'

const CLAUDE_BIN = 'claude'

/**
 * Detect "binary not found" errors raised by `Bun.spawn`. Bun surfaces
 * these as a generic Error whose message contains 'ENOENT' on
 * macOS/Linux. Mirrors the legacy `isMissingBinaryError` so the user gets
 * the same install-hint experience.
 */
function isMissingBinaryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message
  return msg.includes('ENOENT') || msg.includes('No such file')
}

export async function addAccountInteractive(): Promise<void> {
  let proc
  try {
    proc = Bun.spawn({
      cmd: [CLAUDE_BIN, 'auth', 'login'],
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
  } catch (err: unknown) {
    if (isMissingBinaryError(err)) {
      throw new ClaudeCliMissingError()
    }
    throw err
  }
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`\`claude auth login\` exited ${String(exitCode)} during interactive OAuth flow`)
  }
}
