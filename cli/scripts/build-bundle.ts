#!/usr/bin/env bun
/**
 * Bundle build orchestrator for the cvault CLI.
 *
 * Bun's `--compile` Mach-O output is structurally invalid for codesign on
 * macOS (Bun 1.3.12, verified empirically), so the production distribution
 * model is "Bun runtime + bundled JS + Homebrew shim" instead of a
 * self-contained binary. This orchestrator produces the bundle:
 *
 *   bun build --target=bun ./src/index.ts \
 *     --outfile dist/cvault.bundle.js --minify --sourcemap
 *
 * The Homebrew formula (Formula/cvault.rb) ships this single .js file
 * under libexec and writes a 5-line bash shim into bin/cvault that
 * `exec`s it through the homebrew-installed `bun`. One artifact for all
 * platforms — Bun reads the bundle the same way everywhere.
 *
 * URL baking + reset behavior mirrors `scripts/build.ts` (the compile
 * orchestrator): URLs flow from CVAULT_/VITE_/CLERK_ env vars into
 * `src/buildInfo.ts` BEFORE the bun build invocation, then ALWAYS get
 * reset to empty defaults on exit (try/finally + SIGINT/SIGTERM
 * handlers) so dev runs don't pick up baked URLs and the working copy
 * stays clean. The shared helpers live in `./build` and are re-imported
 * here rather than duplicated.
 *
 * Usage:
 *   bun run scripts/build-bundle.ts            # minified release bundle
 *   bun run scripts/build-bundle.ts --no-minify  # debug bundle (readable)
 *
 * Env vars consulted (same precedence chain as the runtime config
 * resolver and the compile orchestrator):
 *   CVAULT_CONVEX_URL          → falls back to VITE_CONVEX_URL
 *   CVAULT_FRONTEND_API_URL    → falls back to CLERK_FRONTEND_API_URL
 *   CVAULT_DASHBOARD_URL       (no fallback)
 */
import { renameSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'

import { EMPTY_BUILD_DEFAULTS, resolveBuildDefaultsFromEnv, writeBuildInfo } from './build'

/** Canonical output path for the production bundle. */
export const DEFAULT_BUNDLE_OUTFILE = 'dist/cvault.bundle.js'

/** Entry point handed to `bun build`. Relative to the cli/ directory. */
const BUNDLE_ENTRY = './src/index.ts'

interface BuildBunBuildArgsInput {
  outdir: string
  minify: boolean
}

/**
 * Construct the argv we hand to `bun` for the bundle build. Pure
 * function — no I/O — so the unit test can assert the argv shape
 * without spawning a subprocess.
 *
 * Why `--outdir` and not `--outfile`: empirically (Bun 1.3.12) the
 * combination of `--outfile` + `--sourcemap` writes both the bundle
 * AND the .map next to the entry instead of into the requested
 * directory — a Bun parser bug. `--outdir` doesn't suffer from it,
 * but it derives the artifact basename from the entry filename, so
 * the orchestrator post-renames `index.js` → `cvault.bundle.js`
 * (and the matching .map) once `bun build` returns.
 *
 * `--bytecode` is intentionally omitted for the bundle target: the
 * bundle is run by the user's locally-installed `bun` at invocation
 * time, and bytecode caches are tied to the exact runtime version that
 * compiled them. Mismatched-version bytecode falls back to source
 * anyway, so it's pure overhead for our distribution model.
 */
export function buildBunBuildArgs({ outdir, minify }: BuildBunBuildArgsInput): readonly string[] {
  // Order matters for readability of the printed `[build] bun ...` line:
  // top-level command, target, entry, outdir, then optimizer flags.
  // `--sourcemap=linked` (vs bare `--sourcemap`) is required so the
  // .map file gets a stable name that we can rename alongside the
  // bundle; bare `--sourcemap` triggers the same outdir-bypass bug
  // described above.
  const args: string[] = ['build', '--target=bun', BUNDLE_ENTRY, '--outdir', outdir]
  if (minify) args.push('--minify')
  args.push('--sourcemap=linked')
  return args
}

interface ParsedBundleArgs {
  outfile: string
  minify: boolean
}

/**
 * Parse the argv slice handed to the bundle orchestrator. The bundle
 * build deliberately takes NO target arg (one bundle for all platforms)
 * and only one optional flag (`--no-minify`) for debug builds.
 *
 * Strict on unknown args — a typo like `--no-minfy` would otherwise
 * silently leave minify on and the user would not notice.
 */
export function parseBuildBundleArgs(argv: ReadonlyArray<string>): ParsedBundleArgs {
  let minify = true
  for (const arg of argv) {
    if (arg === '--no-minify') {
      minify = false
      continue
    }
    throw new Error(`Unknown argument: ${arg}\n` + `Usage: bun run scripts/build-bundle.ts [--no-minify]`)
  }
  return { outfile: DEFAULT_BUNDLE_OUTFILE, minify }
}

interface RunBunBuildArgs {
  argv: readonly string[]
  cwd: string
}

async function runBunBuild({ argv, cwd }: RunBunBuildArgs): Promise<number> {
  console.log(`[build-bundle] bun ${argv.join(' ')}`)
  const proc = Bun.spawn(['bun', ...argv], { cwd, stdout: 'inherit', stderr: 'inherit' })
  return await proc.exited
}

interface OrchestrateArgs {
  outfile: string
  minify: boolean
  cliDir: string
  env: Record<string, string | undefined>
}

async function orchestrate({ outfile, minify, cliDir, env }: OrchestrateArgs): Promise<number> {
  const buildInfoPath = join(cliDir, 'src', 'buildInfo.ts')
  const defaults = resolveBuildDefaultsFromEnv(env)

  // Belt-and-suspenders: if the user kills the process mid-build (^C,
  // SIGTERM), still reset buildInfo.ts so dev URLs don't leak into
  // source. The try/finally below covers normal success/failure paths.
  const resetOnSignal = (): void => {
    try {
      writeBuildInfo(buildInfoPath, EMPTY_BUILD_DEFAULTS)
    } catch {
      /* best-effort during signal handling — surface nothing to stdout */
    }
    process.exit(130) // standard SIGINT exit code
  }
  process.on('SIGINT', resetOnSignal)
  process.on('SIGTERM', resetOnSignal)

  // Bun's `--outdir` derives artifact basenames from the entry file
  // (./src/index.ts → index.js + index.js.map). The Homebrew formula
  // wants `cvault.bundle.js`, so the orchestrator post-renames the
  // pair after the build returns. The outdir itself is what the
  // user-visible `outfile` resolves to (its parent), and the bundle's
  // requested basename becomes the rename target.
  const absoluteOutfile = pathResolve(cliDir, outfile)
  const outdir = dirname(absoluteOutfile)

  try {
    writeBuildInfo(buildInfoPath, defaults)
    const exitCode = await runBunBuild({
      argv: buildBunBuildArgs({ outdir, minify }),
      cwd: cliDir,
    })
    if (exitCode === 0) {
      // Bun emits index.js + index.js.map (entry filename minus .ts,
      // plus .map). Rename both so the canonical artifact pair is
      // `cvault.bundle.js` + `cvault.bundle.js.map` regardless of
      // entry filename.
      renameBundleArtifacts(outdir, absoluteOutfile)
    }
    return exitCode
  } finally {
    writeBuildInfo(buildInfoPath, EMPTY_BUILD_DEFAULTS)
    process.off('SIGINT', resetOnSignal)
    process.off('SIGTERM', resetOnSignal)
  }
}

/**
 * Rename Bun's outdir-derived artifacts (`index.js` + `index.js.map`)
 * to the canonical bundle name pair (`<outfile>` + `<outfile>.map`).
 * Pure-ish — only filesystem renames — so callers can also use it to
 * rename the artifact pair directly in tests if they ever spawn a real
 * bun build. Exported for that reason.
 */
export function renameBundleArtifacts(outdir: string, absoluteOutfile: string): void {
  const bunOut = join(outdir, 'index.js')
  const bunMap = join(outdir, 'index.js.map')
  renameSync(bunOut, absoluteOutfile)
  renameSync(bunMap, `${absoluteOutfile}.map`)
}

// Avoid running orchestrate() when the file is imported by tests. Bun's
// `import.meta.main` is true only when the script is invoked directly
// via `bun run scripts/build-bundle.ts ...`, false when imported.
if (import.meta.main) {
  const { outfile, minify } = parseBuildBundleArgs(process.argv.slice(2))
  // The orchestrator runs from the cli/ directory regardless of where
  // the user invoked `bun run` from — paths in package.json resolve
  // relative to package.json's location anyway.
  const cliDir = pathResolve(import.meta.dir, '..')
  const exitCode = await orchestrate({ outfile, minify, cliDir, env: process.env })
  process.exit(exitCode)
}
