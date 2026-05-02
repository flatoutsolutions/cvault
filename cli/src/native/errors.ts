/**
 * Typed errors for the native credential module.
 *
 * The CLI's top-level handler in `index.ts` prints these error messages
 * verbatim to the user, so the messages must read as actionable
 * remediation hints (e.g. "install the `claude` CLI", "Windows is not
 * supported in v1") rather than internal diagnostics.
 *
 * - `NativeKeychainError` — non-zero exit from `security` (mac) or fs
 *    failure (linux/wsl). Carries `exitCode` + raw `stderr` so callers can
 *    decide whether the error is recoverable (e.g. a 44 from `security`
 *    means "not found" and is non-fatal in certain contexts).
 * - `ClaudeCliMissingError` — `claude` (the Claude Code CLI) is not on PATH;
 *    `cvault add` cannot proceed. Hint points at the install instructions.
 * - `PlatformUnsupportedError` — current `process.platform` value is not in
 *    the v1 supported set. Used to short-circuit Windows.
 */

export class NativeKeychainError extends Error {
  override readonly name = 'NativeKeychainError'
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(message)
  }
}

export class ClaudeCliMissingError extends Error {
  override readonly name = 'ClaudeCliMissingError'
  constructor() {
    super(
      `\`claude\` (the Claude Code CLI) is not installed or not on PATH.\n` +
        `Install it from https://docs.claude.com/en/docs/claude-code, then re-run.`
    )
  }
}

export class PlatformUnsupportedError extends Error {
  override readonly name = 'PlatformUnsupportedError'
  constructor(platform: string) {
    super(
      `cvault does not yet support the \`${platform}\` platform.\n` +
        `macOS, Linux, and WSL are supported in v1. ` +
        `Windows support is tracked as a follow-up issue.`
    )
  }
}
