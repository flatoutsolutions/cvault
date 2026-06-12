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
import { isMissingBinaryError } from './spawn'

const CLAUDE_BIN = 'claude'

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
