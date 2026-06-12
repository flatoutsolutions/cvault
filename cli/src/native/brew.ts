/**
 * `upgradeCvault` — pull the latest cvault release via Homebrew.
 *
 * Why this exists: users repeatedly hit
 *
 *     Warning: flatoutsolutions/cvault/cvault X.Y.Z already installed
 *
 * right after a release and conclude the upgrade is broken. The real cause
 * is a stale local tap. Homebrew only auto-refreshes a tap at most once per
 * `HOMEBREW_AUTO_UPDATE_SECS` (up to ~24h), so a bare `brew upgrade` run
 * inside that window never learns about the freshly-pushed formula and
 * reports the installed version as "already" the newest. The fix is an
 * explicit `brew update` to force the tap refresh BEFORE `brew upgrade`.
 *
 * Both steps inherit stdio so the user watches brew's own progress and
 * sees the authoritative "upgrading…" / "already up to date" output.
 */
import { BrewMissingError } from './errors'

const BREW_BIN = 'brew'

/**
 * The fully tap-qualified formula name. A bare `cvault` could collide with
 * a same-named formula in another tap; the qualified form is unambiguous
 * and matches the `brew install` command shipped in the README / release
 * notes (and `TAP_REPO` in .github/workflows/release-cli.yml).
 */
export const CVAULT_FORMULA = 'flatoutsolutions/cvault/cvault'

/**
 * Detect "binary not found" errors raised by `Bun.spawn`. Bun surfaces
 * these as a generic Error whose message contains 'ENOENT' (or, on some
 * platforms, 'No such file'). Mirrors `native/claudeCli.ts` so a missing
 * `brew` yields the same install-hint experience as a missing `claude`.
 */
function isMissingBinaryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message
  return msg.includes('ENOENT') || msg.includes('No such file')
}

/**
 * Spawn `brew <args>` with inherited stdio and throw on a non-zero exit.
 * A missing `brew` binary is mapped to `BrewMissingError`; every other
 * spawn failure is rethrown verbatim.
 */
async function runBrew(args: string[]): Promise<void> {
  let proc
  try {
    proc = Bun.spawn({
      cmd: [BREW_BIN, ...args],
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
  } catch (err: unknown) {
    if (isMissingBinaryError(err)) {
      throw new BrewMissingError()
    }
    throw err
  }
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`\`brew ${args.join(' ')}\` exited ${String(exitCode)}`)
  }
}

export async function upgradeCvault(): Promise<void> {
  // `brew update` first — this is the step that fixes the "already
  // installed" stale-tap symptom. If it fails we stop here rather than
  // running `brew upgrade` against a tap we know wasn't refreshed.
  await runBrew(['update'])
  await runBrew(['upgrade', CVAULT_FORMULA])
}
