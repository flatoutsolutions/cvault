/**
 * Subprocess wrapper around the vendored `claude-swap` CLI.
 *
 * `claude-swap` is the single Mac-Keychain authority — cvault never touches
 * the keychain directly; every read/write goes through this module via
 * `Bun.spawnSync`.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §7 + §10.
 *
 * Hard rules from the spec:
 *  - 30-second default timeout on every call (Keychain prompts can hang)
 *  - missing binary → typed error so the top-level handler can print an
 *    install hint
 *  - non-zero exit → typed error carrying stderr (we redact tokens before
 *    the user ever sees the message; see `render/redact.ts`)
 */
import type { SyncSubprocess } from 'bun'

const CLAUDE_SWAP_BIN = 'claude-swap'

/**
 * Default hard timeout for non-interactive `claude-swap` calls. Keychain
 * prompts can theoretically hang indefinitely; cvault prefers to fail and
 * surface a clear error rather than appear stuck.
 */
const DEFAULT_TIMEOUT_MS = 30_000

export class ClaudeSwapError extends Error {
  override readonly name = 'ClaudeSwapError'
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(message)
  }
}

export class ClaudeSwapMissingError extends Error {
  override readonly name = 'ClaudeSwapMissingError'
  constructor() {
    super(
      `${CLAUDE_SWAP_BIN} is not installed or not on PATH. Install it with:\n` +
        `    uv tool install claude-swap\n` +
        `Then re-run this command.`
    )
  }
}

export interface RunOptions {
  /** UTF-8 string piped to stdin. */
  stdin?: string
  /** Hard timeout (ms). Default 30s. */
  timeoutMs?: number
}

export interface RunResult {
  stdout: string
  stderr: string
}

/**
 * Detect "binary not found" errors raised by `Bun.spawnSync`. Bun surfaces
 * these as a generic Error whose message contains 'ENOENT' on macOS/Linux.
 */
function isMissingBinaryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message
  return msg.includes('ENOENT') || msg.includes('No such file')
}

/**
 * Run `claude-swap` synchronously, returning the decoded stdout/stderr.
 * Throws on non-zero exit code or when the binary is missing.
 */
export function runClaudeSwap(args: readonly string[], opts: RunOptions = {}): RunResult {
  let proc: SyncSubprocess<'pipe', 'pipe'>
  try {
    proc = Bun.spawnSync({
      cmd: [CLAUDE_SWAP_BIN, ...args],
      stdin:
        opts.stdin !== undefined ? Buffer.from(opts.stdin, 'utf8') : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
  } catch (err: unknown) {
    if (isMissingBinaryError(err)) {
      throw new ClaudeSwapMissingError()
    }
    throw err
  }

  const stdout = new TextDecoder().decode(proc.stdout)
  const stderr = new TextDecoder().decode(proc.stderr)

  if (proc.exitCode !== 0) {
    throw new ClaudeSwapError(
      `claude-swap ${args.join(' ')} exited ${String(proc.exitCode)}\nstderr: ${stderr.trim()}`,
      proc.exitCode,
      stderr
    )
  }

  return { stdout, stderr }
}

// ---------------------------------------------------------------------------
// Verb-specific helpers — verified envelope shape from python-cli-tooling.md §3
// (extracted from claude-swap's transfer.py; the wrapping language changed
// from Python to TS, the envelope did not).
// ---------------------------------------------------------------------------

/** A single account inside a `claude-swap --export -` envelope. */
export interface ClaudeSwapAccount {
  number: number
  email: string
  uuid: string
  organizationUuid?: string
  organizationName?: string
  added: string
  credentials: {
    claudeAiOauth: {
      accessToken: string
      refreshToken: string
      expiresAt: number
      scopes: string[]
      subscriptionType: 'max' | 'pro'
    }
  }
  config?: { oauthAccount?: Record<string, unknown> }
}

/** The full `claude-swap --export -` envelope shape. */
export interface ClaudeSwapEnvelope {
  version: 1
  exportedAt: string
  exportedFrom: string
  swapVersion: string
  encrypted: false
  activeAccountNumber: number
  accounts: ClaudeSwapAccount[]
}

/**
 * `claude-swap --export - --account <id> --full` → parsed envelope.
 *
 * We pass `--full` so each account carries the complete `oauthAccount`
 * sub-document from `~/.claude.json` (15+ fields: `accountUuid`,
 * `emailAddress`, `organizationUuid`, `seatTier`, `displayName`, etc.).
 * Without `--full`, claude-swap exports only the Keychain `claudeAiOauth`
 * blob and leaves `config.oauthAccount` empty — which makes a later
 * `claude-swap --switch-to` fail backup-validation with "Invalid
 * oauthAccount in backup".
 */
export function exportAccount(slotOrEmail: string | number): ClaudeSwapEnvelope {
  const { stdout } = runClaudeSwap([
    '--export',
    '-',
    '--account',
    String(slotOrEmail),
    '--full',
  ])
  try {
    return JSON.parse(stdout) as ClaudeSwapEnvelope
  } catch (err) {
    throw new ClaudeSwapError(
      `claude-swap --export emitted non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      0,
      ''
    )
  }
}

/** `claude-swap --export -` → parsed envelope (all accounts). */
export function exportAll(): ClaudeSwapEnvelope {
  const { stdout } = runClaudeSwap(['--export', '-'])
  try {
    return JSON.parse(stdout) as ClaudeSwapEnvelope
  } catch (err) {
    throw new ClaudeSwapError(
      `claude-swap --export emitted non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      0,
      ''
    )
  }
}

/** `claude-swap --import - [--force]` from a JSON envelope. */
export function importEnvelope(envelope: ClaudeSwapEnvelope, force = false): void {
  const args = ['--import', '-', ...(force ? ['--force'] : [])]
  runClaudeSwap(args, { stdin: JSON.stringify(envelope) })
}

export function switchTo(slotOrEmail: string | number): void {
  runClaudeSwap(['--switch-to', String(slotOrEmail)])
}

export function removeAccount(slotOrEmail: string | number): void {
  runClaudeSwap(['--remove-account', String(slotOrEmail)])
}

/**
 * `claude-swap --purge` — atomically wipe every account claude-swap
 * manages, plus the corresponding Keychain entries. Used by `cvault clean`
 * to avoid the off-by-one trap where iterative `--remove-account` calls
 * would skip slots after each renumber.
 *
 * claude-swap reads its own y/N confirmation from stdin. We pipe `y\n` so
 * the call is non-interactive — `cvault clean` already collected consent
 * upstream. (`--force` is rejected here: per `claude-swap --help` it's
 * valid only with `--import`.)
 */
export function purge(): void {
  runClaudeSwap(['--purge'], { stdin: 'y\n' })
}

export function status(): string {
  return runClaudeSwap(['--status']).stdout
}

/**
 * `claude-swap --add-account` — interactive Claude Code OAuth flow. Inherits
 * stdin/stdout/stderr so the user can see prompts and type responses.
 *
 * UX recipe (from the cvault add command):
 *   1. Print a banner explaining what's about to happen.
 *   2. Spawn claude-swap --add-account with stdio: 'inherit'.
 *   3. On success, run claude-swap --status to learn the new active slot.
 *   4. Call exportAccount(slot) and forward the envelope to Convex.
 *
 * No timeout is set — the user controls when this finishes (Ctrl-C aborts).
 */
export async function addAccountInteractive(): Promise<void> {
  let proc
  try {
    proc = Bun.spawn({
      cmd: [CLAUDE_SWAP_BIN, '--add-account'],
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
  } catch (err: unknown) {
    if (isMissingBinaryError(err)) {
      throw new ClaudeSwapMissingError()
    }
    throw err
  }
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new ClaudeSwapError(
      `claude-swap --add-account exited ${String(exitCode)}`,
      exitCode,
      ''
    )
  }
}
