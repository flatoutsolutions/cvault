/**
 * Tests for the bundle build orchestrator helpers
 * (`cli/scripts/build-bundle.ts`).
 *
 * The bundle orchestrator is the Bun-runtime distribution counterpart to
 * `cli/scripts/build.ts`. It runs `bun build --target=bun` (NO `--compile`)
 * to produce a single portable `dist/cvault.bundle.js` that the Homebrew
 * formula's shim wraps with `exec bun cvault.bundle.js "$@"`. Everything
 * URL-baking-related (writeBuildInfo + reset on exit + signal handling) is
 * shared with the compile orchestrator via re-exports from `./build`, so
 * those helpers are not re-tested here — see `build.test.ts` for that.
 *
 * What we DO test here:
 *   1. The argv passed to `bun build` is exactly what we want for the
 *      bundle target (correct flags, correct outfile, correct entry).
 *   2. `--no-minify` toggles the `--minify` flag off (debug builds).
 *   3. CLI arg parsing returns sensible defaults and rejects unknown args
 *      so a typo at the command line surfaces immediately rather than
 *      silently producing an unminified or wrong-shaped bundle.
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_BUNDLE_OUTFILE, buildBunBuildArgs, parseBuildBundleArgs } from '../../scripts/build-bundle'

describe('buildBunBuildArgs', () => {
  it('emits a minified, sourcemap=linked bundle build argv targeting bun via --outdir', () => {
    const args = buildBunBuildArgs({ outdir: 'dist', minify: true })
    expect(args).toEqual([
      'build',
      '--target=bun',
      './src/index.ts',
      '--outdir',
      'dist',
      '--minify',
      '--sourcemap=linked',
    ])
  })

  it('omits --minify when minify=false (debug bundle)', () => {
    const args = buildBunBuildArgs({ outdir: 'dist', minify: false })
    expect(args).not.toContain('--minify')
    // Sourcemap stays on for debug builds too — and it must be the
    // `=linked` form to dodge the Bun 1.3.12 outfile/sourcemap bug.
    expect(args).toContain('--sourcemap=linked')
    expect(args).not.toContain('--sourcemap') // bare flag would silently misbehave
    expect(args).toContain('./src/index.ts')
  })
})

describe('parseBuildBundleArgs', () => {
  it('returns the canonical bundle outfile and minify=true on empty argv', () => {
    expect(parseBuildBundleArgs([])).toEqual({
      outfile: DEFAULT_BUNDLE_OUTFILE,
      minify: true,
    })
  })

  it('flips minify off when --no-minify is passed', () => {
    expect(parseBuildBundleArgs(['--no-minify'])).toEqual({
      outfile: DEFAULT_BUNDLE_OUTFILE,
      minify: false,
    })
  })

  it('rejects unknown flags to surface typos immediately', () => {
    // Misspelt `--no-minfy` would otherwise silently leave minify=true.
    expect(() => parseBuildBundleArgs(['--no-minfy'])).toThrowError(/Unknown argument/)
  })

  it('rejects positional arguments (the bundle build takes no target)', () => {
    // The compile orchestrator (`build.ts`) takes a target; the bundle
    // orchestrator deliberately does not — the artifact is portable.
    expect(() => parseBuildBundleArgs(['bun-darwin-arm64'])).toThrowError(/Unknown argument/)
  })
})
