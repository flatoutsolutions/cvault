/**
 * `addAccountInteractive` — spawn `claude` (the Claude Code CLI) so the
 * user can complete the OAuth flow.
 *
 * This replaces `claude-swap --add-account`. The recipe is identical:
 *   1. Banner from cvault explaining what's about to happen.
 *   2. Spawn `claude` with `stdio: 'inherit'` so the user sees the OAuth
 *      prompt and can paste the token / hit return.
 *   3. After `claude` exits 0, the local credentials store has the new
 *      tokens and `~/.claude.json` has the new `oauthAccount`. The caller
 *      (cvault add) then runs `buildEnvelope` to capture what was just
 *      written.
 *
 * No timeout — the user controls when this finishes (Ctrl-C aborts).
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
      cmd: [CLAUDE_BIN],
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
    throw new Error(`\`claude\` exited ${String(exitCode)} during interactive OAuth flow`)
  }
}
