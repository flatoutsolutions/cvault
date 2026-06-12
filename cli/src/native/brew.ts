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
import { isMissingBinaryError } from './spawn'

const BREW_BIN = 'brew'

/**
 * The fully tap-qualified formula name. A bare `cvault` could collide with
 * a same-named formula in another tap; the qualified form is unambiguous
 * and matches the `brew install flatoutsolutions/cvault/cvault` command
 * shipped in the README and release notes (release-cli.yml).
 */
export const CVAULT_FORMULA = 'flatoutsolutions/cvault/cvault'

/**
 * Spawn `brew <args>` with inherited stdio and return its exit code. A
 * missing `brew` binary is mapped to `BrewMissingError`; every other spawn
 * failure is rethrown verbatim. Callers decide what a non-zero exit means
 * (fatal vs. recoverable), so this does NOT throw on non-zero.
 */
async function runBrew(args: string[]): Promise<number> {
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
  return proc.exited
}

export async function upgradeCvault(): Promise<void> {
  // `brew update` first — this is the step that fixes the "already
  // installed" stale-tap symptom. A non-zero exit here is NOT fatal: brew
  // update commonly reports errors for an unrelated tap (a network blip,
  // another tap failing to fetch) while still refreshing ours, and aborting
  // would defeat the command's whole purpose. Warn and press on; a genuinely
  // broken state will surface again at the upgrade step below.
  const updateExit = await runBrew(['update'])
  if (updateExit !== 0) {
    console.error(`warning: \`brew update\` exited ${String(updateExit)} — continuing with upgrade anyway.`)
  }

  const upgradeExit = await runBrew(['upgrade', CVAULT_FORMULA])
  if (upgradeExit !== 0) {
    throw new Error(`\`brew upgrade ${CVAULT_FORMULA}\` exited ${String(upgradeExit)}`)
  }
}
