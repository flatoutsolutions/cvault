# cvault — TypeScript on Bun CLI Tooling Reference Brief

**Date:** 2026-05-02
**Status:** Research output, drives §7 (CLI) implementation of [`/docs/superpowers/specs/2026-05-02-cvault-design.md`](../superpowers/specs/2026-05-02-cvault-design.md) after the Python → TypeScript/Bun pivot.
**Audience:** the engineer building the `cvault` CLI under `cli/` (Bun runtime, distributed as a single static binary plus `bunx`)
**Scope:** This brief replaces `python-cli-tooling.md`. It covers everything that changes with the runtime swap. Auth-flow shape (browser-assisted Clerk sign-in token + ticket exchange via localhost callback), the Anthropic OAuth refresh contract, and the `/api/oauth/usage` shape are unchanged from `clerk-convex-tanstack-integration.md`, `anthropic-oauth-refresh.md`, `anthropic-usage.md` — read those first; this brief assumes them.

---

## TL;DR — picks at the top

| Concern            | Pick                                                                                                                          | Reason (one line)                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Argument parser    | **`citty`**                                                                                                                   | Zero-dep, `defineCommand` reads as a spec, native lazy sub-command imports, recommended for Bun-first CLIs. Commander wins on maturity but Citty's structured `args` + lazy loader fit our 8 verbs and keep the binary lean. |
| CLI runtime        | **Bun ≥ 1.2**                                                                                                                 | Spec; ships `Bun.spawn`, `Bun.serve`, `bun build --compile`, native TS, `node:*` shims.                                                                                                                                      |
| Convex client      | **`ConvexHttpClient`** from `convex/browser`                                                                                  | HTTP, not WS — short-lived CLI; passes `Authorization: Bearer <jwt>` via `setAuth`; type-safe via generated `api`.                                                                                                           |
| Clerk SDK          | **`@clerk/backend` 3.x** for `createClerkClient` (already in monorepo `package.json`)                                         | Backend mint of sign-in tokens / session revoke. CLI also hits Clerk **FAPI** directly via `fetch` for the ticket exchange + token refresh — no SDK exists for FAPI ticket strategy.                                         |
| Subprocess wrapper | **`Bun.spawn`**                                                                                                               | Returns `Subprocess` with `.exited`, `.stdout` (`ReadableStream`), `.stdin` (FileSink), native `AbortSignal` + `timeout` support.                                                                                            |
| Localhost callback | **`Bun.serve({ port: 0 })`**                                                                                                  | Random free port returned via `server.port`; `server.stop(true)` for hard close after first valid POST.                                                                                                                      |
| Single-binary      | **`bun build --compile --minify --bytecode --sourcemap --target=...`**                                                        | Standalone executables per triple; `--bytecode` halves cold start.                                                                                                                                                           |
| Distribution       | **Homebrew tap (primary), GitHub Releases (binaries by triple), `bunx cvault` (Bun-equipped)**                                | Mac-first, native install path; releases driven by GitHub Actions matrix.                                                                                                                                                    |
| Linter / formatter | **eslint + prettier** (matches monorepo)                                                                                      | Blueprint root already standardizes on ESLint flat config + Prettier with import sort + Tailwind plugin. Zero tooling drift inside cvault.                                                                                   |
| Test framework     | **Vitest 4.x** (mandated; same as Convex backend + frontend)                                                                  | Run under Bun via `bunx vitest` or Node — both work.                                                                                                                                                                         |
| Mocking            | **`vi.mock()`** module mocks; **`vi.spyOn(globalThis.Bun, 'spawn')`** for subprocess; in-memory `FakeVaultClient` for Convex. |

---

## 1. Bun build & distribute recipe

### 1.1 `bun build --compile` invocations

Bun ships static binaries that embed the runtime. Targets we ship in v1:

```bash
# macOS Apple Silicon (primary dev target — Stefan's machines)
bun build --compile --minify --sourcemap --bytecode \
  --target=bun-darwin-arm64 \
  ./cli/src/index.ts \
  --outfile dist/cvault-darwin-arm64

# macOS Intel
bun build --compile --minify --sourcemap --bytecode \
  --target=bun-darwin-x64 \
  ./cli/src/index.ts \
  --outfile dist/cvault-darwin-x64

# Linux x64 (CI runners, Docker, dev VMs)
bun build --compile --minify --sourcemap --bytecode \
  --target=bun-linux-x64 \
  ./cli/src/index.ts \
  --outfile dist/cvault-linux-x64

# Linux ARM64 (Graviton, Raspberry Pi, Apple-Silicon Linux VMs) — cheap to add
bun build --compile --minify --sourcemap --bytecode \
  --target=bun-linux-arm64 \
  ./cli/src/index.ts \
  --outfile dist/cvault-linux-arm64
```

**Output naming convention:** `cvault-<os>-<arch>` for downloads. Homebrew renames to `cvault` on install. `bunx cvault` resolves the `cvault` bin field from `package.json`.

**Flag reference (verified against Bun 1.2 docs):**

| Flag                       | Why we set it                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--compile`                | Produces a standalone executable (implies `--production`).                                                                   |
| `--minify`                 | All three (whitespace + identifiers + syntax). Bun's minifier is fast enough that we always use it for releases.             |
| `--sourcemap`              | `linked` mode by default with `--compile`. Lets us decode stack traces from user reports without shipping `.map` separately. |
| `--bytecode`               | Embeds JSC bytecode → cold start ~2× faster. Cost: a few extra MB on disk.                                                   |
| `--target=bun-<os>-<arch>` | Cross-compile target. Defaults to host. Without explicit target, the GH Actions matrix is moot.                              |

**Optional CPU sub-targets:** `bun-linux-x64-baseline` (pre-2013 CPUs, nehalem ISA) vs `bun-linux-x64-modern` (haswell+). Default omits the suffix and uses a sensible mid-tier ISA. Skip in v1 unless a user reports an `Illegal instruction` crash.

### 1.2 Single-binary tradeoffs

| Aspect                       | Reality                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Size**                     | `--compile` embeds the entire Bun runtime (Zig-built JSC + libuv equivalents). Per-binary size is ~95-110 MB before compression, ~50-60 MB after gzip. Homebrew bottle compression (xz) gets it down further. **Document this in the README** so users don't think it's bloated cvault code — it's the runtime.                                                                                                  |
| **Startup**                  | With `--bytecode`: ~30-50 ms cold start on Apple Silicon for a CLI of our size. Comparable to a Go binary, much faster than Python.                                                                                                                                                                                                                                                                              |
| **Embedded runtime caveats** | The binary IS Bun. Native modules requested at runtime (e.g. `node:fs/promises`) are resolved against the embedded runtime — no NPM postinstall step on the user's machine. **`require()` of files that weren't seen at bundle time will fail** — keep all imports static. No `await import('./foo.ts')` with a dynamic path; a static-string dynamic import is fine and is how `citty` lazy-loads sub-commands. |
| **Code-signing on macOS**    | Distributing unsigned binaries triggers Gatekeeper warning on first launch. v1 acceptance: ship unsigned, document `xattr -d com.apple.quarantine /usr/local/bin/cvault` in the README troubleshooting section. v2: pursue a Developer ID + notarization. Homebrew installs from a tap that controls the URL also avoid the quarantine flag because `brew` writes the file.                                      |
| **Linux glibc**              | Bun's Linux binaries link against modern glibc (≥ 2.31). Old distros (CentOS 7, Ubuntu 18.04) will fail. Document the floor; users on ancient distros use `bunx cvault` instead.                                                                                                                                                                                                                                 |

### 1.3 `bunx cvault` mode

For users who already have Bun installed: skip the binary download entirely.

```bash
bunx cvault@latest login
```

Mechanism:

- We publish the package to npm as `cvault` (or `@stefan/cvault` if collision — pick at impl-time, npm search needed).
- `package.json` has `"bin": { "cvault": "./dist/cli.js" }` pointing at a **non-compiled** ESM bundle (`bun build ./cli/src/index.ts --target=bun --outfile dist/cli.js --minify`).
- bunx caches the package in `~/.bun/install/cache`, then runs the bin against the user's existing Bun runtime. Saves the ~95 MB embedded runtime.

We ship **both**:

- npm package → bunx + `bun add -g cvault`
- compiled binaries → Homebrew + manual download

### 1.4 Homebrew tap formula skeleton

Tap repo: `flatoutsolutions/homebrew-cvault` → `Formula/cvault.rb`. (Convention: `homebrew-<x>` is the tap; users invoke `brew tap flatoutsolutions/cvault && brew install cvault`.)

```ruby
# Formula/cvault.rb
class Cvault < Formula
  desc "Centralized Claude Code credential vault — wraps claude-swap with Convex sync"
  homepage "https://github.com/flatoutsolutions/cvault"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/flatoutsolutions/cvault/releases/download/v#{version}/cvault-darwin-arm64"
      sha256 "REPLACE_WITH_SHA256_FROM_RELEASE_PIPELINE"
    end
    on_intel do
      url "https://github.com/flatoutsolutions/cvault/releases/download/v#{version}/cvault-darwin-x64"
      sha256 "REPLACE_WITH_SHA256_FROM_RELEASE_PIPELINE"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/flatoutsolutions/cvault/releases/download/v#{version}/cvault-linux-arm64"
      sha256 "REPLACE_WITH_SHA256_FROM_RELEASE_PIPELINE"
    end
    on_intel do
      url "https://github.com/flatoutsolutions/cvault/releases/download/v#{version}/cvault-linux-x64"
      sha256 "REPLACE_WITH_SHA256_FROM_RELEASE_PIPELINE"
    end
  end

  depends_on "claude-swap" # if claude-swap is brewable; otherwise document a manual install in caveats

  def install
    bin.install Dir["cvault-*"].first => "cvault"
  end

  def caveats
    <<~EOS
      cvault wraps `claude-swap`. If you don't already have it:

          uv tool install claude-swap

      Then run:

          cvault login

      to authenticate this machine via your browser.
    EOS
  end

  test do
    assert_match "cvault", shell_output("#{bin}/cvault --version")
  end
end
```

The `sha256` lines are templated by the GH Actions release pipeline (§1.5) — the workflow computes them from the artifacts and commits/pushes a formula update via PAT.

### 1.5 GitHub Actions release pipeline

Single workflow, triggered by `v*` tag push. Build all four triples in parallel, attach to release, then update the tap formula.

```yaml
# .github/workflows/release-cli.yml
name: Release cvault CLI

on:
  push:
    tags:
      - 'v*.*.*'

jobs:
  build:
    name: Build ${{ matrix.triple }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - { triple: darwin-arm64, runner: macos-14, target: bun-darwin-arm64 }
          - { triple: darwin-x64, runner: macos-13, target: bun-darwin-x64 }
          - { triple: linux-x64, runner: ubuntu-latest, target: bun-linux-x64 }
          - { triple: linux-arm64, runner: ubuntu-latest, target: bun-linux-arm64 }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: false

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install root deps
        run: bun install --frozen-lockfile
        # Note: cvault uses yarn at the root; if `yarn install --immutable`
        # is preferred for parity, use `actions/setup-node` + corepack, then
        # `yarn install --immutable`. Bun is required at build-time only.

      - name: Generate Convex types
        run: |
          bunx convex codegen
        env:
          CONVEX_DEPLOY_KEY: ${{ secrets.CONVEX_DEPLOY_KEY }}

      - name: Build
        working-directory: cli
        run: |
          bun build --compile --minify --sourcemap --bytecode \
            --target=${{ matrix.target }} \
            ./src/index.ts \
            --outfile ../dist/cvault-${{ matrix.triple }}

      - name: SHA256
        id: sha
        run: |
          shasum -a 256 dist/cvault-${{ matrix.triple }} | awk '{print $1}' > dist/cvault-${{ matrix.triple }}.sha256
          echo "sha256=$(cat dist/cvault-${{ matrix.triple }}.sha256)" >> $GITHUB_OUTPUT

      - uses: actions/upload-artifact@v4
        with:
          name: cvault-${{ matrix.triple }}
          path: |
            dist/cvault-${{ matrix.triple }}
            dist/cvault-${{ matrix.triple }}.sha256

  release:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: dist
          merge-multiple: true

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/cvault-darwin-arm64
            dist/cvault-darwin-arm64.sha256
            dist/cvault-darwin-x64
            dist/cvault-darwin-x64.sha256
            dist/cvault-linux-x64
            dist/cvault-linux-x64.sha256
            dist/cvault-linux-arm64
            dist/cvault-linux-arm64.sha256
          generate_release_notes: true

  publish-npm:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Build ESM bundle for bunx
        working-directory: cli
        run: |
          bun build ./src/index.ts --target=bun --outfile dist/cli.js --minify
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org/'
      - name: Publish
        working-directory: cli
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

  update-tap:
    needs: release
    runs-on: ubuntu-latest
    steps:
      - name: Checkout tap repo
        uses: actions/checkout@v4
        with:
          repository: flatoutsolutions/homebrew-cvault
          token: ${{ secrets.HOMEBREW_TAP_PAT }}
          path: tap

      - uses: actions/download-artifact@v4
        with:
          path: dist
          merge-multiple: true

      - name: Compute version
        id: version
        run: echo "version=${GITHUB_REF_NAME#v}" >> $GITHUB_OUTPUT

      - name: Render formula
        run: |
          VERSION=${{ steps.version.outputs.version }}
          SHA_DARWIN_ARM64=$(cat dist/cvault-darwin-arm64.sha256)
          SHA_DARWIN_X64=$(cat dist/cvault-darwin-x64.sha256)
          SHA_LINUX_ARM64=$(cat dist/cvault-linux-arm64.sha256)
          SHA_LINUX_X64=$(cat dist/cvault-linux-x64.sha256)

          # `bunx --bun` ensures the embedded Bun runs (deterministic across CI runners).
          bunx --bun zx ./tap/scripts/render-formula.mjs \
            --version "$VERSION" \
            --sha-darwin-arm64 "$SHA_DARWIN_ARM64" \
            --sha-darwin-x64   "$SHA_DARWIN_X64" \
            --sha-linux-arm64  "$SHA_LINUX_ARM64" \
            --sha-linux-x64    "$SHA_LINUX_X64" \
            > tap/Formula/cvault.rb

      - name: Commit + push
        working-directory: tap
        run: |
          git config user.name 'cvault-bot'
          git config user.email 'cvault-bot@flatoutsolutions.com'
          git add Formula/cvault.rb
          git commit -m "cvault ${{ steps.version.outputs.version }}"
          git push
```

**Secrets needed in repo settings:**

- `HOMEBREW_TAP_PAT` — fine-grained PAT with `contents:write` on `flatoutsolutions/homebrew-cvault`
- `NPM_TOKEN` — npm automation token for `cvault` package
- `CONVEX_DEPLOY_KEY` — only needed if `convex codegen` requires server access (it doesn't for type generation from local files; can omit if `convex/_generated/` is committed)

**Re. `convex/_generated/` in git:** the existing cvault repo has `convex/_generated/` checked in (`api.d.ts`, `api.js`, etc.). Keep it that way — the CLI build needs the types and shouldn't depend on a live Convex deployment to release.

---

## 2. `Bun.spawn` patterns for `claude-swap` wrapping

### 2.1 The shape of `Bun.spawn`

Verified against Bun 1.2 docs (`docs/runtime/child-process.mdx`):

- Sync subprocess: `Bun.spawnSync(cmd, opts)` returns `{ exitCode, stdout, stderr }` as `Uint8Array`.
- Async subprocess: `Bun.spawn(cmd, opts)` returns `Subprocess` with `.exited` (Promise<exitCode>), `.stdout` (ReadableStream), `.stderr` (ReadableStream), `.stdin` (FileSink if `stdin: 'pipe'`).
- Built-in `signal: AbortSignal` and `timeout: number` (ms) options. **The `timeout` option exists** — no need for `AbortSignal.timeout(...)` unless we want a single signal that controls multiple processes.

### 2.2 Sync wrapper for short-lived calls

Most `claude-swap` calls are < 1 second (export, switch-to, status). Sync API is fine and gives the simplest call sites.

```ts
// cli/src/claudeSwap.ts
import type { Subprocess } from 'bun'

const CLAUDE_SWAP_BIN = 'claude-swap'

export class ClaudeSwapError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(message)
    this.name = 'ClaudeSwapError'
  }
}

export class ClaudeSwapMissingError extends Error {
  constructor() {
    super(
      `claude-swap is not installed or not on PATH. Install it with:\n` +
        `    uv tool install claude-swap\n` +
        `Then re-run this command.`
    )
    this.name = 'ClaudeSwapMissingError'
  }
}

interface RunOptions {
  /** UTF-8 string piped to stdin. */
  stdin?: string
  /** Hard timeout (ms). Default 30s — Keychain prompts can hang. */
  timeoutMs?: number
}

interface RunResult {
  stdout: string
  stderr: string
}

/** Sync run; throws on non-zero exit or missing binary. */
export function runClaudeSwap(args: readonly string[], opts: RunOptions = {}): RunResult {
  let proc: Bun.SyncSubprocess<'pipe', 'pipe'>
  try {
    proc = Bun.spawnSync({
      cmd: [CLAUDE_SWAP_BIN, ...args],
      stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin, 'utf8') : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: opts.timeoutMs ?? 30_000,
    })
  } catch (err) {
    // Bun surfaces missing binary as an Error containing 'ENOENT' / 'No such file or directory'
    // depending on platform. Re-shape to a domain error.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ENOENT') || msg.includes('No such file')) {
      throw new ClaudeSwapMissingError()
    }
    throw err
  }

  const stdout = new TextDecoder().decode(proc.stdout)
  const stderr = new TextDecoder().decode(proc.stderr)

  if (proc.exitCode !== 0) {
    throw new ClaudeSwapError(
      `claude-swap ${args.join(' ')} exited ${proc.exitCode}\nstderr: ${stderr.trim()}`,
      proc.exitCode,
      stderr
    )
  }

  return { stdout, stderr }
}

// ---------------------------------------------------------------------------
// Verb-specific helpers — Verified envelope shape from python-cli-tooling.md §3
// ---------------------------------------------------------------------------

/** Single-account export envelope shape (verified from claude-swap transfer.py). */
export interface ClaudeSwapEnvelope {
  version: 1
  exportedAt: string
  exportedFrom: string
  swapVersion: string
  encrypted: false
  activeAccountNumber: number
  accounts: Array<{
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
  }>
}

export function exportAccount(slotOrEmail: string | number): ClaudeSwapEnvelope {
  const { stdout } = runClaudeSwap(['--export', '-', '--account', String(slotOrEmail)])
  try {
    return JSON.parse(stdout) as ClaudeSwapEnvelope
  } catch (err) {
    throw new ClaudeSwapError(
      `claude-swap --export emitted non-JSON: ${err instanceof Error ? err.message : err}`,
      0,
      ''
    )
  }
}

export function exportAll(): ClaudeSwapEnvelope {
  return JSON.parse(runClaudeSwap(['--export', '-']).stdout) as ClaudeSwapEnvelope
}

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

export function status(): string {
  return runClaudeSwap(['--status']).stdout
}

// ---------------------------------------------------------------------------
// Two-phase passthrough for `--add-account`
// ---------------------------------------------------------------------------

/**
 * `claude-swap --add-account` is fully interactive — the user signs into Claude Code
 * (browser flow inside the user's terminal session, may print URL + paste prompt).
 * We MUST inherit stdin/stdout so the user can see prompts and type responses.
 *
 * Use this as **phase 1** of `cvault add`. After it returns successfully,
 * call `exportAccount(<the new slot>)` (phase 2) to grab the envelope and ship to Convex.
 *
 * UX recipe (cvault add):
 *   1. Print "Opening Claude Code login flow…"
 *   2. Spawn claude-swap --add-account with stdio: 'inherit'.
 *   3. On success, run claude-swap --status to learn the new active slot.
 *   4. Call exportAccount(slot) and forward the envelope to Convex.
 */
export async function addAccountInteractive(): Promise<void> {
  const proc = Bun.spawn({
    cmd: [CLAUDE_SWAP_BIN, '--add-account'],
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new ClaudeSwapError(`claude-swap --add-account exited ${exitCode}`, exitCode, '')
  }
}
```

### 2.3 Streaming variant (only if needed)

We don't need streaming today — `claude-swap` outputs are small. Document the pattern for future use:

```ts
const proc = Bun.spawn({
  cmd: ['some-streaming-tool'],
  stdout: 'pipe',
})
for await (const chunk of proc.stdout) {
  process.stdout.write(chunk)
}
await proc.exited
```

### 2.4 Missing-binary handling

`Bun.spawn` / `Bun.spawnSync` throws synchronously when the binary cannot be found. The error is an `Error` whose `.message` contains `ENOENT` on macOS/Linux. We re-shape it to `ClaudeSwapMissingError` (above) so the top-level error printer gives the install hint.

**Top-level handler (in `cli/src/index.ts`):**

```ts
try {
  await runMain(main)
} catch (err) {
  if (err instanceof ClaudeSwapMissingError) {
    console.error(err.message)
    process.exit(127) // standard "command not found" exit
  }
  if (err instanceof ClaudeSwapError) {
    console.error(`error: ${err.message}`)
    process.exit(err.exitCode ?? 1)
  }
  throw err // unknown — let Bun print stack
}
```

### 2.5 30-second timeout

Set `timeout: 30_000` on every non-interactive call (already shown in `runClaudeSwap`). For the interactive `--add-account`, **do not** set a timeout — the user is in control. If the user wants to abort, they hit Ctrl-C and the inherited stdin propagates SIGINT.

If we ever need a single signal that controls a tree of subprocesses (we don't yet): pass `signal: AbortSignal.timeout(30_000)` instead of `timeout`. The two are mutually compatible but redundant — pick one per call.

---

## 3. `Bun.serve` for the localhost auth callback

### 3.1 The localhost listener

Used during `cvault login` for step 4 of the Clerk sign-in token + ticket flow (per `clerk-convex-tanstack-integration.md` §4): the dashboard POSTs `{state, signInToken}` to `http://127.0.0.1:<random>/`, the CLI captures it, validates state, exchanges for a session, persists.

```ts
// cli/src/auth/callbackServer.ts
import { timingSafeEqual } from 'node:crypto'

export interface CallbackResult {
  /** The Clerk sign-in token to exchange for a session. */
  signInToken: string
}

export interface StartCallbackOptions {
  /** Random nonce the CLI generated and passed to the dashboard via the URL. */
  expectedState: string
  /** Total time the user has to complete the browser flow. Default 2 min. */
  timeoutMs?: number
}

export interface CallbackHandle {
  /** The bound port. The CLI uses this to construct the dashboard URL. */
  port: number
  /** Resolves with the captured sign-in token, or rejects on timeout/abort. */
  result: Promise<CallbackResult>
  /** Stop the server early (e.g. on Ctrl-C in the CLI). */
  cancel(): Promise<void>
}

/**
 * Bind 127.0.0.1 on a random free port. Wait for ONE valid POST then shut down.
 * If no valid POST arrives within `timeoutMs`, reject and shut down.
 */
export function startCallbackServer(opts: StartCallbackOptions): CallbackHandle {
  const expectedStateBytes = new TextEncoder().encode(opts.expectedState)
  let resolveResult!: (r: CallbackResult) => void
  let rejectResult!: (err: Error) => void
  const result = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0, // OS picks a free port; read it back from server.port
    async fetch(req) {
      if (req.method !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }
      let body: { state?: unknown; signInToken?: unknown }
      try {
        body = (await req.json()) as typeof body
      } catch {
        return new Response('invalid JSON', { status: 400 })
      }
      const state = typeof body.state === 'string' ? body.state : ''
      const signInToken = typeof body.signInToken === 'string' ? body.signInToken : ''
      if (!state || !signInToken) {
        return new Response('missing state or signInToken', { status: 400 })
      }

      // Constant-time compare to defeat timing oracles on the state nonce.
      const stateBytes = new TextEncoder().encode(state)
      if (stateBytes.byteLength !== expectedStateBytes.byteLength || !timingSafeEqual(stateBytes, expectedStateBytes)) {
        return new Response('state mismatch', { status: 400 })
      }

      // Resolve before stopping — stop() awaits in-flight responses, so the
      // dashboard sees a 200 before the socket closes.
      resolveResult({ signInToken })
      // Shut down on next tick so this 200 makes it back to the dashboard.
      queueMicrotask(() => {
        void server.stop(true)
      })
      return new Response('ok', { status: 200 })
    },
  })

  // Total timeout — if the user never completes the browser flow.
  const timeout = setTimeout(
    () => {
      rejectResult(new Error('Browser sign-in timed out. Re-run `cvault login` to try again.'))
      void server.stop(true)
    },
    opts.timeoutMs ?? 2 * 60 * 1000
  )

  // If the result resolves naturally, clear the timeout.
  void result.finally(() => clearTimeout(timeout))

  return {
    port: server.port,
    result,
    cancel: async () => {
      clearTimeout(timeout)
      await server.stop(true)
    },
  }
}
```

### 3.2 Notes on `Bun.serve`

| Detail                                                        | Reference                                                                                                                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port: 0` → random free port; read it back from `server.port` | Verified against `docs/runtime/http/server.mdx` ("Using a Random Port with Bun.serve"). Bun explicitly recommends `port: 0` over hand-rolled port pickers.                                            |
| `hostname: '127.0.0.1'` not `'localhost'`                     | per `clerk-convex-tanstack-integration.md` §7: some browsers/extensions block `localhost` from resolving to `127.0.0.1`.                                                                              |
| `await server.stop(true)`                                     | `true` closes active connections immediately; without it, `stop()` waits for in-flight requests to finish. We use `true` after we've already returned the 200, so the queued response goes out first. |
| `timingSafeEqual` from `node:crypto`                          | Bun ships `node:crypto` (verified — `docs/runtime/nodejs-compat.mdx`); `timingSafeEqual` is implemented.                                                                                              |

### 3.3 Wiring into the login command

```ts
// cli/src/commands/login.ts (sketch — full file in §7 layout)
import { startCallbackServer } from '../auth/callbackServer'
import { exchangeTicketForSession } from '../auth/clerkFapi'
import { writeSession } from '../session/store'

export async function loginCommand(args: { dashboardUrl: string }): Promise<void> {
  const state = crypto.randomUUID() // 36 bytes of entropy is plenty
  const handle = startCallbackServer({ expectedState: state })

  const linkUrl = new URL('/cli/link', args.dashboardUrl)
  linkUrl.searchParams.set('redirect', `http://127.0.0.1:${handle.port}/`)
  linkUrl.searchParams.set('state', state)

  console.log(`Opening browser for sign-in:\n  ${linkUrl}`)
  await openBrowser(linkUrl.toString()) // small util — `open` shell-out works fine

  console.log('Waiting for sign-in to complete (close this terminal to cancel)...')
  const { signInToken } = await handle.result

  const session = await exchangeTicketForSession(signInToken)
  await writeSession(session)
  console.log('Signed in. You can close the browser tab.')
}
```

`openBrowser`: shell to `open` on macOS, `xdg-open` on Linux. `Bun.spawn(['open', url])` is one line.

---

## 4. `ConvexHttpClient` from a CLI process

### 4.1 Import + basic usage

```ts
import { ConvexHttpClient } from 'convex/browser'

import { api } from '../../convex/_generated/api'

// path alias makes this nicer (§7)

const client = new ConvexHttpClient(process.env.CVAULT_CONVEX_URL ?? 'https://beloved-mouse-707.convex.cloud')
```

The `convex/browser` entrypoint is officially supported in Node and Bun — it uses `fetch`. No WebSocket. Verified in `docs/client/javascript`.

### 4.2 `setAuth(jwt)` semantics

`ConvexHttpClient.setAuth(jwt)` stores the token on the instance. **All subsequent `query/mutation/action` calls send `Authorization: Bearer <jwt>`** until you call `setAuth(null)` / `clearAuth()` or replace it. There is no auto-refresh built into `ConvexHttpClient` (unlike `ConvexReactClient`, which calls a `fetchToken` callback). We own the refresh loop ourselves (§5).

```ts
client.setAuth(jwt) // synchronous — no network call
const result = await client.query(api.users.actions.current, {})
```

### 4.3 Type-safe calls via generated `api`

```ts
import { api } from '../../convex/_generated/api'

// Query
const subs = await client.query(api.subscriptions.queries.listForUser, {})

// Mutation
await client.mutation(api.subscriptions.mutations.softRemove, { slot: 1 })

// Action
const pulled = await client.action(api.subscriptions.actions.pullForSwitch, { slotOrEmail: '1' })
```

The path alias `convex/_generated/api` is wired via `cli/tsconfig.json` (§7) so cli code does `import { api } from '@cvault/convex/api'` and gets full IntelliSense.

### 4.4 Detecting 401 / Unauthenticated errors

`ConvexHttpClient` throws on non-2xx. The thrown error is a generic `Error` whose `.message` follows the format `<status_code> <error_code>: <message>`. There is no built-in "is auth error" predicate.

`ConvexError` (from `convex/values`) is reserved for application errors thrown via `throw new ConvexError(...)` inside Convex functions. It does **not** fire on transport-level 401. Our `authenticatedQuery`/`authenticatedMutation` wrappers throw `Error('Not authenticated')` on missing identity — that surfaces as a generic `Error` with message containing `Not authenticated`.

```ts
// cli/src/convex/isAuthError.ts
import { ConvexError } from 'convex/values'

export function isAuthError(err: unknown): boolean {
  if (err instanceof ConvexError) {
    // Application errors that explicitly mention auth
    const msg =
      typeof err.data === 'object' && err.data !== null && 'message' in err.data
        ? String((err.data as { message: unknown }).message)
        : err.message
    return /not authenticated|unauthenticated|auth/i.test(msg)
  }
  if (err instanceof Error) {
    const msg = err.message
    return (
      msg.includes('401') ||
      /unauthenticated/i.test(msg) ||
      /not authenticated/i.test(msg) ||
      /authentication/i.test(msg)
    )
  }
  return false
}
```

### 4.5 `VaultClient` wrapper with auto-refresh on 401

```ts
// cli/src/convex/vaultClient.ts
import { ConvexHttpClient } from 'convex/browser'
import type { FunctionReference, OptionalRestArgsOrSkip } from 'convex/server'

import { api } from '../../../convex/_generated/api'
import { mintConvexJwt, readSession, writeSession } from '../auth/session'
import { isAuthError } from './isAuthError'

/** Type-safe wrapper that handles JWT refresh on 401 then retries once. */
export class VaultClient {
  private readonly http: ConvexHttpClient

  constructor(
    public readonly deploymentUrl: string,
    initialJwt: string
  ) {
    this.http = new ConvexHttpClient(deploymentUrl)
    this.http.setAuth(initialJwt)
  }

  async query<Q extends FunctionReference<'query'>>(
    fn: Q,
    ...args: OptionalRestArgsOrSkip<Q>
  ): Promise<Q['_returnType']> {
    return this.callWithRetry(() => this.http.query(fn, ...args))
  }

  async mutation<M extends FunctionReference<'mutation'>>(
    fn: M,
    ...args: OptionalRestArgsOrSkip<M>
  ): Promise<M['_returnType']> {
    return this.callWithRetry(() => this.http.mutation(fn, ...args))
  }

  async action<A extends FunctionReference<'action'>>(
    fn: A,
    ...args: OptionalRestArgsOrSkip<A>
  ): Promise<A['_returnType']> {
    return this.callWithRetry(() => this.http.action(fn, ...args))
  }

  private async callWithRetry<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (err) {
      if (!isAuthError(err)) throw err

      // 401 — try a single refresh + retry. If refresh itself fails with auth,
      // the long-lived Clerk session is dead → user must re-run `cvault login`.
      const session = await readSession()
      const fresh = await mintConvexJwt(session)
      await writeSession({ ...session, ...fresh })
      this.http.setAuth(fresh.convexJwt)
      return await call()
    }
  }
}

/** Construct from the on-disk session. Convenient one-shot for CLI commands. */
export async function makeVaultClient(): Promise<VaultClient> {
  const session = await readSession()
  return new VaultClient(session.convexUrl, session.convexJwt)
}

// Re-export `api` for callers (keeps imports compact in commands/).
export { api } from '../../../convex/_generated/api'
```

The generic types `FunctionReference<'query'>` etc. are exported from `convex/server` and propagate full IntelliSense for args + return types.

---

## 5. Clerk JWT refresh wrapper

### 5.1 Tokens we hold

| Token               | TTL                                    | Source                                                                           | Rotation                                                    |
| ------------------- | -------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `clerkSessionId`    | n/a (id)                               | from ticket exchange response                                                    | never                                                       |
| `clerkSessionToken` | 7-30 days (per Clerk session settings) | from ticket exchange response — Set-Cookie `__session` body in the FAPI response | not refreshed; expiry → re-run `cvault login`               |
| `convexJwt`         | ~60 s                                  | minted on demand from FAPI `/v1/client/sessions/<id>/tokens/convex`              | every call once we're within 10 s of expiry, OR after a 401 |

### 5.2 `mintConvexJwt`

```ts
// cli/src/auth/clerkFapi.ts
import type { SessionState } from './session'

export interface MintResult {
  convexJwt: string
  convexJwtExpiry: number // unix seconds
}

export class ClerkSessionExpiredError extends Error {
  constructor() {
    super('Clerk session expired or revoked. Re-run `cvault login`.')
    this.name = 'ClerkSessionExpiredError'
  }
}

export async function mintConvexJwt(session: SessionState): Promise<MintResult> {
  const url = `${session.frontendApiUrl}/v1/client/sessions/${session.clerkSessionId}/tokens/convex`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.clerkSessionToken}`,
      'User-Agent': cliUserAgent(),
    },
  })
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new ClerkSessionExpiredError()
  }
  if (!res.ok) {
    throw new Error(`Clerk FAPI mint failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { jwt: string }
  return {
    convexJwt: body.jwt,
    convexJwtExpiry: decodeJwtExp(body.jwt),
  }
}

function decodeJwtExp(jwt: string): number {
  const [, payloadB64] = jwt.split('.')
  // base64url decode without external dep
  const padded = payloadB64
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(payloadB64.length + ((4 - (payloadB64.length % 4)) % 4), '=')
  const json = JSON.parse(atob(padded)) as { exp: number }
  return json.exp
}

export function cliUserAgent(): string {
  // Send a recognizable UA so Clerk session activity shows "cvault CLI".
  // (clerk-convex-tanstack-integration.md §6 calls this out as required.)
  const version = '0.1.0' // pulled from cli/package.json at build time via define constant
  const platform = `${process.platform}-${process.arch}`
  return `cvault-cli/${version} (${platform})`
}
```

### 5.3 Ticket exchange

Per `clerk-convex-tanstack-integration.md` §5 — POST to FAPI `/v1/client/sign_ins` with `strategy=ticket`:

```ts
// cli/src/auth/clerkFapi.ts (continued)
import type { SessionState } from './session'

export interface ExchangeOptions {
  signInToken: string
  frontendApiUrl: string
  convexUrl: string
  /** Origin that the dashboard runs on — set to your deployed dashboard origin
   * if Clerk's CORS check rejects bare requests. Optional in many environments. */
  dashboardOrigin?: string
}

export async function exchangeTicketForSession(opts: ExchangeOptions): Promise<SessionState> {
  // Step A — exchange the ticket for a Client/Session
  const signInRes = await fetch(`${opts.frontendApiUrl}/v1/client/sign_ins`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': cliUserAgent(),
      ...(opts.dashboardOrigin ? { Origin: opts.dashboardOrigin } : {}),
    },
    body: new URLSearchParams({ strategy: 'ticket', ticket: opts.signInToken }),
  })
  if (!signInRes.ok) {
    throw new Error(`Clerk FAPI sign_in failed: ${signInRes.status} ${await signInRes.text()}`)
  }
  const signInBody = (await signInRes.json()) as {
    client?: {
      sessions?: Array<{
        id: string
        last_active_token?: { jwt: string }
      }>
      last_active_session_id?: string
    }
  }
  const clerkSessionId = signInBody.client?.last_active_session_id
  const session = signInBody.client?.sessions?.find((s) => s.id === clerkSessionId)
  const clerkSessionToken = session?.last_active_token?.jwt
  if (!clerkSessionId || !clerkSessionToken) {
    throw new Error('Clerk FAPI sign_in did not return a usable session token')
  }

  // Step B — immediately mint a convex-template JWT
  const minted = await mintConvexJwt({
    frontendApiUrl: opts.frontendApiUrl,
    clerkSessionId,
    clerkSessionToken,
    convexJwt: '', // not needed for the mint call itself
    convexJwtExpiry: 0,
    convexUrl: opts.convexUrl,
    issuedAt: Math.floor(Date.now() / 1000),
    version: 1,
    machineLabel: undefined,
    clerkUserId: undefined,
  } as unknown as SessionState)

  return {
    version: 1,
    clerkSessionId,
    clerkSessionToken,
    frontendApiUrl: opts.frontendApiUrl,
    convexUrl: opts.convexUrl,
    convexJwt: minted.convexJwt,
    convexJwtExpiry: minted.convexJwtExpiry,
    issuedAt: Math.floor(Date.now() / 1000),
    machineLabel: undefined,
    clerkUserId: undefined, // can be filled in by a follow-up users.current call
  }
}
```

### 5.4 Atomic session persist

```ts
// cli/src/auth/session.ts
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SessionState {
  version: 1
  clerkUserId?: string
  clerkSessionId: string
  clerkSessionToken: string
  convexJwt: string
  convexJwtExpiry: number
  frontendApiUrl: string
  convexUrl: string
  issuedAt: number
  machineLabel?: string
}

const VAULT_DIR = join(homedir(), '.vault')
const SESSION_FILE = join(VAULT_DIR, 'session.json')

export class NotLoggedInError extends Error {
  constructor() {
    super('Not logged in. Run `cvault login`.')
    this.name = 'NotLoggedInError'
  }
}

export async function readSession(): Promise<SessionState> {
  const file = Bun.file(SESSION_FILE)
  if (!(await file.exists())) {
    throw new NotLoggedInError()
  }
  // Permissions check — refuse loose perms (defense in depth on a creds file)
  const stats = await file.stat()
  // file.stat() returns mode in node:fs format; mask & 0o077 must be 0
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${SESSION_FILE} has loose permissions. Run \`chmod 600 ${SESSION_FILE}\` and retry.`)
  }
  return (await file.json()) as SessionState
}

export async function writeSession(state: SessionState): Promise<void> {
  await ensureVaultDir()
  const tmp = `${SESSION_FILE}.tmp`
  await Bun.write(tmp, JSON.stringify(state, null, 2))
  await Bun.$`chmod 600 ${tmp}`.quiet()
  await Bun.$`mv ${tmp} ${SESSION_FILE}`.quiet()
  await Bun.$`chmod 600 ${SESSION_FILE}`.quiet()
}

async function ensureVaultDir(): Promise<void> {
  await Bun.$`mkdir -p ${VAULT_DIR}`.quiet()
  await Bun.$`chmod 700 ${VAULT_DIR}`.quiet()
}

// Re-export the FAPI helper for convenience
export { mintConvexJwt, ClerkSessionExpiredError } from './clerkFapi'
```

Notes:

- `Bun.$` (Bun Shell) is fine for shell-outs to `chmod` / `mv`. The atomic write pattern is `write tmp → fsync → rename`. `Bun.write` does not expose `fsync`; `mv` is atomic on the same filesystem (POSIX rename guarantee), so we get crash-consistency without an extra dep.
- `Bun.file(...).stat()` returns `node:fs.Stats`; the `mode` field has the standard POSIX bits.
- Perm-check on read is **mandatory** — a creds file with `0644` is leaking to other users on shared systems.

### 5.5 Detection of long-lived session expiry

Clerk's response when `clerkSessionToken` is dead: 401 / 403 / 404 from `/v1/client/sessions/<id>/tokens/convex`. The wrapper above maps all three to `ClerkSessionExpiredError`. Catch at the top level:

```ts
} catch (err) {
  if (err instanceof ClerkSessionExpiredError || err instanceof NotLoggedInError) {
    console.error(err.message)
    process.exit(1)
  }
  throw err
}
```

A future refinement: on `ClerkSessionExpiredError`, automatically re-trigger `cvault login` if interactive (TTY check), then retry the original command. Not in v1 — keep the prompt explicit so users know what's happening.

---

## 6. Argument parser pick — `citty`

### 6.1 Decision

**Pick: `citty`** (`/unjs/citty`).

### 6.2 Reasoning

| Criterion             | citty                                                                                                                                                                                         | commander                                                                                                 | Verdict                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------ |
| TypeScript ergonomics | `defineCommand({ args: { name: { type: 'positional', required: true } }, run({ args }) })` — `args` typed by the schema, no cast needed                                                       | Builder API, action callbacks need explicit typing or `@commander-js/extra-typings` add-on                | citty                          |
| Bundle size           | Zero deps (verified — citty README, single source). One file, ~15 KB                                                                                                                          | Larger — pulls in chalk-derived help printer (commander v12 is ~80 KB before tree-shake)                  | citty                          |
| Sub-command shape     | `subCommands: { login: loginCmd, switch: switchCmd, ... }` reads as a manifest; supports lazy `() => import('./commands/switch').then(m => m.default)` for code-splitting (helps binary size) | `program.command('switch <id>').description(...).action(handler)` chained — works fine but harder to scan | citty                          |
| Maturity              | Used by Nuxt/UnJS ecosystem, 1k+ stars, maintained                                                                                                                                            | 26k stars, oldest in the field, stable API                                                                | commander wins on raw maturity |
| Shell completion      | Not built-in (open issue)                                                                                                                                                                     | Built-in via `program.completion()` plugin                                                                | commander wins                 |
| Help quality          | Auto-generated, terse                                                                                                                                                                         | Auto-generated, more convention                                                                           | tie                            |

**Verdict:** citty for v1. The lazy sub-command imports + zero-dep + cleaner spec read shape outweigh the lack of native shell completion. Shell completion can be hand-written later as a `cvault completion` command emitting a static bash/zsh script — implementation cost ~30 LOC.

### 6.3 Skeleton — `cli/src/index.ts`

```ts
// cli/src/index.ts
import { defineCommand, runMain } from 'citty'

const main = defineCommand({
  meta: {
    name: 'cvault',
    version: '0.1.0',
    description: 'Centralized Claude Code credential vault',
  },
  subCommands: {
    login: () => import('./commands/login').then((m) => m.loginCommand),
    add: () => import('./commands/add').then((m) => m.addCommand),
    list: () => import('./commands/list').then((m) => m.listCommand),
    switch: () => import('./commands/switch').then((m) => m.switchCommand),
    refresh: () => import('./commands/refresh').then((m) => m.refreshCommand),
    remove: () => import('./commands/remove').then((m) => m.removeCommand),
    status: () => import('./commands/status').then((m) => m.statusCommand),
    sync: () => import('./commands/sync').then((m) => m.syncCommand),
  },
})

await runMain(main).catch((err) => {
  // Top-level error printer — see §2.4 for typed handling
  console.error(`error: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
```

Each command file exports a `defineCommand`-shaped value, e.g.:

```ts
// cli/src/commands/switch.ts
import { defineCommand } from 'citty'

import { importEnvelope, switchTo } from '../claudeSwap'
import { api, makeVaultClient } from '../convex/vaultClient'

// ...

export const switchCommand = defineCommand({
  meta: {
    name: 'switch',
    description: 'Switch to a Claude Code account by slot or email',
  },
  args: {
    target: { type: 'positional', description: 'Slot number or email', required: true },
  },
  async run({ args }) {
    const client = await makeVaultClient()
    const pulled = await client.action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: args.target,
    })
    // ... hash compare, importEnvelope if needed, switchTo
  },
})
```

---

## 7. Project layout

The CLI lives in a `cli/` subfolder of the cvault monorepo. It shares Convex types with the backend via a tsconfig path alias.

### 7.1 Folder tree

```
cvault/                                       # repo root (existing)
├── cli/                                      # new — the CLI module
│   ├── package.json                          # § 7.2
│   ├── tsconfig.json                         # § 7.3
│   ├── vitest.config.ts                      # § 7.4
│   ├── README.md                             # short — points to top-level docs
│   ├── src/
│   │   ├── index.ts                          # citty main; registers sub-commands (§6.3)
│   │   ├── commands/
│   │   │   ├── login.ts                      # cvault login
│   │   │   ├── add.ts                        # cvault add
│   │   │   ├── list.ts                       # cvault list
│   │   │   ├── switch.ts                     # cvault switch <slot|email>
│   │   │   ├── refresh.ts                    # cvault refresh [slot]
│   │   │   ├── remove.ts                     # cvault remove <slot|email>
│   │   │   ├── status.ts                     # cvault status
│   │   │   └── sync.ts                       # cvault sync --all
│   │   ├── auth/
│   │   │   ├── callbackServer.ts             # Bun.serve on 127.0.0.1:0 (§3)
│   │   │   ├── clerkFapi.ts                  # ticket exchange + mintConvexJwt (§5.2/5.3)
│   │   │   ├── session.ts                    # ~/.vault/session.json read/write (§5.4)
│   │   │   └── openBrowser.ts                # Bun.spawn(['open', url]) shim
│   │   ├── claudeSwap.ts                     # subprocess wrapper (§2.2)
│   │   ├── convex/
│   │   │   ├── vaultClient.ts                # VaultClient + makeVaultClient (§4.5)
│   │   │   └── isAuthError.ts                # auth-error predicate (§4.4)
│   │   ├── render/
│   │   │   ├── table.ts                      # column-aligned table renderer for `cvault list`
│   │   │   └── status.ts                     # status output formatter
│   │   ├── hashing.ts                        # Bun.hash / SHA-256 of plaintext envelope
│   │   ├── paths.ts                          # ~/.vault/, last-hash-{email}.txt (§5.4 has session; this has the others)
│   │   └── errors.ts                         # CvaultError hierarchy
│   ├── tests/
│   │   ├── setup.ts                          # vitest setup (replaces conftest)
│   │   ├── fixtures/
│   │   │   └── envelopes/
│   │   │       ├── singleAccount.ts          # factory for verified envelope shape
│   │   │       └── threeAccounts.ts
│   │   ├── claudeSwap.test.ts
│   │   ├── auth/
│   │   │   ├── callbackServer.test.ts
│   │   │   ├── clerkFapi.test.ts
│   │   │   └── session.test.ts
│   │   ├── convex/
│   │   │   └── vaultClient.test.ts
│   │   └── commands/
│   │       ├── login.test.ts
│   │       ├── add.test.ts
│   │       ├── switch.test.ts
│   │       └── list.test.ts
│   └── dist/                                 # gitignored — compiled binaries land here
│
├── convex/                                   # existing, unchanged
│   ├── _generated/
│   │   ├── api.d.ts                          # CLI imports types from here
│   │   └── api.js
│   └── …
├── frontend/                                 # existing, unchanged
├── package.json                              # existing root — yarn workspace if we want
├── tsconfig.json                             # existing root
└── …
```

### 7.2 `cli/package.json`

```json
{
  "name": "cvault",
  "version": "0.1.0",
  "description": "Centralized Claude Code credential vault — wraps claude-swap with Convex sync.",
  "type": "module",
  "license": "MIT",
  "author": "Stefan Asseg <stefan@flatout.solutions>",
  "homepage": "https://github.com/flatoutsolutions/cvault",
  "repository": {
    "type": "git",
    "url": "https://github.com/flatoutsolutions/cvault.git",
    "directory": "cli"
  },
  "bugs": {
    "url": "https://github.com/flatoutsolutions/cvault/issues"
  },
  "keywords": ["claude", "claude-code", "credentials", "convex", "oauth", "cli"],
  "engines": {
    "bun": ">=1.2.0"
  },
  "bin": {
    "cvault": "./dist/cli.js"
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "dev": "bun run src/index.ts --",
    "build:bunx": "bun build ./src/index.ts --target=bun --outfile dist/cli.js --minify",
    "build:darwin-arm64": "bun build --compile --minify --sourcemap --bytecode --target=bun-darwin-arm64 ./src/index.ts --outfile dist/cvault-darwin-arm64",
    "build:darwin-x64": "bun build --compile --minify --sourcemap --bytecode --target=bun-darwin-x64 ./src/index.ts --outfile dist/cvault-darwin-x64",
    "build:linux-x64": "bun build --compile --minify --sourcemap --bytecode --target=bun-linux-x64 ./src/index.ts --outfile dist/cvault-linux-x64",
    "build:linux-arm64": "bun build --compile --minify --sourcemap --bytecode --target=bun-linux-arm64 ./src/index.ts --outfile dist/cvault-linux-arm64",
    "build:all": "bun run build:darwin-arm64 && bun run build:darwin-x64 && bun run build:linux-x64 && bun run build:linux-arm64",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest",
    "lint:check": "eslint src tests",
    "lint:fix": "eslint src tests --fix",
    "format:check": "prettier --check src tests",
    "format:fix": "prettier --write src tests"
  },
  "dependencies": {
    "citty": "^0.1.6",
    "convex": "^1.32.0"
  },
  "devDependencies": {
    "@clerk/backend": "^3.0.2",
    "@types/bun": "^1.2.0",
    "@types/node": "^25.3.3",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  }
}
```

Notes:

- `convex` is a runtime dep — `ConvexHttpClient` lives in `convex/browser`.
- `@clerk/backend` is dev-only **for the CLI** — most Clerk operations from the CLI hit FAPI directly via `fetch`. We pull `@clerk/backend` only if a future feature wants `verifyToken()` locally; currently optional. If unused at impl-time, delete it.
- `@types/bun` is required for `Bun.spawn`, `Bun.serve`, `Bun.file`, etc. types under TypeScript.
- No `lefthook`/`husky` here — root has its own.

### 7.3 `cli/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["bun-types"],
    "baseUrl": ".",
    "paths": {
      "@cvault/convex/api": ["../convex/_generated/api"],
      "@cvault/convex/dataModel": ["../convex/_generated/dataModel"]
    },
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "noUncheckedSideEffectImports": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "allowImportingTsExtensions": false,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*", "tests/**/*", "../convex/_generated/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

The `paths` alias gives `import { api } from '@cvault/convex/api'`. If we'd rather use the relative path (`../../convex/_generated/api`) for parity with the dashboard, drop the alias and update imports. Both work; the alias is cleaner and matches the spec wording in §7 of the design doc ("shares `convex/_generated/` types via TS path alias").

### 7.4 `cli/vitest.config.ts`

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node', // CLI runs in Node-like Bun runtime; jsdom adds nothing
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.d.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
      reporter: ['text', 'html', 'lcov'],
    },
  },
})
```

We keep this file scoped to the CLI; the root `vitest.config.ts` continues to govern Convex backend + frontend tests. Two configs, no overlap. CI invokes them separately (`yarn test` at root + `cd cli && bun run test`).

---

## 8. Test patterns under Vitest

### 8.1 `tests/setup.ts`

```ts
// cli/tests/setup.ts
import { afterEach, vi } from 'vitest'

// Reset module + spy state between tests for isolation.
afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

// Override HOME so anything writing to ~/.vault/ lands in the OS temp dir per test.
// Each test file should set its own per-test tmp dir via vi.stubEnv or by mocking
// node:os homedir(). This setup file does NOT set a global HOME — that would
// interfere with tests that need real homedir behavior (none currently, but explicit
// > implicit).
```

### 8.2 Mocking the `VaultClient` wrapper

In-memory fake — same shape as the real wrapper, lets command tests assert calls:

```ts
// cli/tests/fixtures/fakeVaultClient.ts
import type { FunctionReference, OptionalRestArgsOrSkip } from 'convex/server'

export class FakeVaultClient {
  queryResponses = new Map<string, unknown>()
  mutationResponses = new Map<string, unknown>()
  actionResponses = new Map<string, unknown>()
  calls: Array<{ kind: 'query' | 'mutation' | 'action'; name: string; args: unknown }> = []

  async query<Q extends FunctionReference<'query'>>(
    fn: Q,
    ...[args]: OptionalRestArgsOrSkip<Q>
  ): Promise<Q['_returnType']> {
    return this.dispatch('query', fn, args) as Q['_returnType']
  }

  async mutation<M extends FunctionReference<'mutation'>>(
    fn: M,
    ...[args]: OptionalRestArgsOrSkip<M>
  ): Promise<M['_returnType']> {
    return this.dispatch('mutation', fn, args) as M['_returnType']
  }

  async action<A extends FunctionReference<'action'>>(
    fn: A,
    ...[args]: OptionalRestArgsOrSkip<A>
  ): Promise<A['_returnType']> {
    return this.dispatch('action', fn, args) as A['_returnType']
  }

  private dispatch(
    kind: 'query' | 'mutation' | 'action',
    fn: FunctionReference<'query' | 'mutation' | 'action'>,
    args: unknown
  ): unknown {
    // FunctionReference's runtime tag includes the dotted name in `_componentPath` /
    // `_name`; in tests we look it up by string. Convex's generated `api` proxy emits
    // the dotted name as `String(fn)` → e.g. "subscriptions:listForUser".
    const name = String(fn)
    this.calls.push({ kind, name, args })
    const table =
      kind === 'query' ? this.queryResponses : kind === 'mutation' ? this.mutationResponses : this.actionResponses
    return table.get(name) ?? null
  }
}
```

Then in a test, swap the wrapper:

```ts
// cli/tests/commands/switch.test.ts
import { describe, expect, it, vi } from 'vitest'

import { FakeVaultClient } from '../fixtures/fakeVaultClient'

vi.mock('../../src/convex/vaultClient', async (orig) => {
  const actual = await orig<typeof import('../../src/convex/vaultClient')>()
  return {
    ...actual,
    makeVaultClient: vi.fn(),
  }
})

describe('cvault switch', () => {
  it('imports + switches when content hash differs', async () => {
    const fake = new FakeVaultClient()
    fake.actionResponses.set('subscriptions/actions:pullForSwitch', {
      email: 'u@x.com',
      slot: 1,
      plaintextBlob: '{"claudeAiOauth": {…}}',
      contentHash: 'abc123',
    })
    const { makeVaultClient } = await import('../../src/convex/vaultClient')
    vi.mocked(makeVaultClient).mockResolvedValue(fake as unknown as Awaited<ReturnType<typeof makeVaultClient>>)
    // … run the command, assert claudeSwap.importEnvelope was called, etc.
  })
})
```

### 8.3 Mocking `Bun.spawn`

`Bun` is a global object. Spying directly works but the type is read-only in `@types/bun`, so prefer module-level abstraction OR use `Object.defineProperty` for the spy.

**Recommended pattern: wrap `Bun.spawn` in our own `claudeSwap.ts` (we already do — `runClaudeSwap`) and mock the wrapper** rather than `Bun.spawn` itself. This keeps tests at a meaningful boundary (verb-level claude-swap calls) and avoids fighting Bun typings.

```ts
// cli/tests/commands/add.test.ts
import { describe, expect, it, vi } from 'vitest'

import { addAccountInteractive, exportAccount, status } from '../../src/claudeSwap'
import singleAccountEnvelope from '../fixtures/envelopes/singleAccount'

vi.mock('../../src/claudeSwap', () => ({
  runClaudeSwap: vi.fn(),
  exportAccount: vi.fn(),
  exportAll: vi.fn(),
  importEnvelope: vi.fn(),
  switchTo: vi.fn(),
  removeAccount: vi.fn(),
  status: vi.fn(),
  addAccountInteractive: vi.fn().mockResolvedValue(undefined),
}))

describe('cvault add', () => {
  it('runs interactive add then exports the new slot', async () => {
    vi.mocked(status).mockReturnValue('Active account: 3 (new@example.com)\n')
    vi.mocked(exportAccount).mockReturnValue(singleAccountEnvelope())
    // … run the command, assert flow
    expect(addAccountInteractive).toHaveBeenCalledOnce()
    expect(exportAccount).toHaveBeenCalledWith(3)
  })
})
```

If we **must** spy on `Bun.spawn` directly (e.g. testing `runClaudeSwap` itself), use:

```ts
import { describe, expect, it, vi } from 'vitest'

describe('runClaudeSwap', () => {
  it('throws ClaudeSwapMissingError on ENOENT', async () => {
    const spawnSyncSpy = vi.spyOn(Bun, 'spawnSync').mockImplementation(() => {
      throw new Error('spawn ENOENT')
    })
    const { runClaudeSwap, ClaudeSwapMissingError } = await import('../src/claudeSwap')
    expect(() => runClaudeSwap(['--status'])).toThrow(ClaudeSwapMissingError)
    spawnSyncSpy.mockRestore()
  })
})
```

`vi.spyOn(Bun, 'spawnSync')` works because `Bun` is a regular object property of `globalThis`. `as any` is **not** required if you spy on the global `Bun` (TS resolves the type via `@types/bun`).

### 8.4 Mocking `Bun.serve` for the auth callback test

`Bun.serve` returns a real server bound to a real local port — there's no value in mocking it. **Run the real server** in tests; it's a 0-cost local socket and gives us actual end-to-end coverage of state validation, JSON parsing, and shutdown.

```ts
// cli/tests/auth/callbackServer.test.ts
import { describe, expect, it } from 'vitest'

import { startCallbackServer } from '../../src/auth/callbackServer'

describe('startCallbackServer', () => {
  it('resolves with signInToken on valid POST', async () => {
    const handle = startCallbackServer({ expectedState: 'state-abc', timeoutMs: 5_000 })
    const url = `http://127.0.0.1:${handle.port}/`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'state-abc', signInToken: 'sit_xyz' }),
    })
    expect(resp.status).toBe(200)
    const result = await handle.result
    expect(result).toEqual({ signInToken: 'sit_xyz' })
  })

  it('rejects mismatched state', async () => {
    const handle = startCallbackServer({ expectedState: 'state-abc', timeoutMs: 1_000 })
    const url = `http://127.0.0.1:${handle.port}/`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'wrong', signInToken: 'sit_xyz' }),
    })
    expect(resp.status).toBe(400)
    await handle.cancel()
  })

  it('times out after the configured window', async () => {
    const handle = startCallbackServer({ expectedState: 'state-abc', timeoutMs: 50 })
    await expect(handle.result).rejects.toThrow(/timed out/)
  })
})
```

### 8.5 Verified envelope fixture

```ts
// cli/tests/fixtures/envelopes/singleAccount.ts
import type { ClaudeSwapEnvelope } from '../../../src/claudeSwap'

export default function singleAccountEnvelope(
  overrides: Partial<ClaudeSwapEnvelope['accounts'][number]> = {}
): ClaudeSwapEnvelope {
  return {
    version: 1,
    exportedAt: '2026-05-02T16:00:00Z',
    exportedFrom: 'macos',
    swapVersion: '0.10.1',
    encrypted: false,
    activeAccountNumber: 1,
    accounts: [
      {
        number: 1,
        email: 'user@example.com',
        uuid: '11111111-1111-1111-1111-111111111111',
        organizationUuid: '22222222-2222-2222-2222-222222222222',
        organizationName: 'Test Org',
        added: '2026-04-01T00:00:00Z',
        credentials: {
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-test',
            refreshToken: 'sk-ant-ort01-test',
            expiresAt: 1735689600000,
            scopes: ['user:inference', 'user:profile'],
            subscriptionType: 'max',
          },
        },
        config: {
          oauthAccount: {
            /* slim Claude config */
          },
        },
        ...overrides,
      },
    ],
  }
}
```

The envelope shape is the **verified** shape from `python-cli-tooling.md` §3 (extracted from `claude-swap`'s `transfer.py`). That extraction is still correct — only the language wrapping it changed.

### 8.6 Coverage thresholds

`cli/vitest.config.ts` ships with 80% line coverage threshold per spec §11. Convex backend stays at 90% in its own config; frontend at 70% in its own config. Three independent thresholds, three independent test runs.

---

## 9. Linting & formatting

### 9.1 Decision

**Pick: `eslint` + `prettier` (matches monorepo).**

The Blueprint root (and cvault, scaffolded from it) already standardize on ESLint flat config + Prettier with the import-sort and Tailwind plugins. Verified configs:

- `/Users/saadings/Desktop/cvault/eslint.config.ts` — flat config using `@convex-dev/eslint-plugin`, `@tanstack/eslint-config`, `typescript-eslint` recommended-type-checked.
- `/Users/saadings/Desktop/cvault/.prettierrc` — `singleQuote: true`, `printWidth: 120`, `semi: false`, `trailingComma: 'es5'`, plugins for Tailwind + import sort.

Adding biome to a monorepo that already runs eslint + prettier in CI = unnecessary tooling drift. The CLI inherits the existing tooling for free if we extend the root configs.

### 9.2 How to wire it

**Lint:** the existing `eslint.config.ts` already globs `**/*.{js,mjs,cjs,ts,tsx,mts,cts}` for the non-frontend block. The CLI under `cli/src/**/*.ts` will be picked up automatically. Add an exclusion for `cli/dist/`:

```ts
// eslint.config.ts (at repo root) — single line addition to ignores
ignores: ['dist', 'frontend/dist', 'cli/dist', 'convex/_generated', '.yarn', '.agents'],
```

**Format:** `.prettierrc` already covers all `.ts` files. No change needed. The CLI `package.json` `scripts.format:check` runs prettier locally; root `format:check` covers the whole repo for CI.

**TypeScript-ESLint type-aware rules:** the root `eslint.config.ts` uses `projectService: true`. That requires every `.ts` file to be in **some** tsconfig's `include`. The CLI `cli/tsconfig.json` (§7.3) covers `src/**/*` and `tests/**/*`, so we're fine. If ESLint complains about a CLI file not being in any TS project, add it to `cli/tsconfig.json` `include`.

**One lint config for the whole repo, three tsconfigs (root for Convex, frontend for the SPA, cli for the CLI). Three vitest configs. This matches the existing pattern.**

### 9.3 `.prettierignore` addition

Add `cli/dist/` to `.prettierignore` so the formatter doesn't try to format compiled output.

---

## 10. Open questions for the implementation builder

1. **Dashboard origin for FAPI ticket exchange.** The CLI's POST to `/v1/client/sign_ins` may need an `Origin` header that matches Clerk's allowed origins (per `clerk-convex-tanstack-integration.md` §7). Verify by attempting bare and adding the dashboard origin only if 4xx with `Origin not allowed`. This is a Clerk-environment-dependent check.

2. **`@clerk/backend` necessity.** The CLI doesn't currently need `@clerk/backend` — all Clerk operations go through FAPI via `fetch`. It's listed in `cli/package.json` devDependencies as a hedge for future `verifyToken` use. Decide at impl-time whether to keep or remove.

3. **`api` proxy `String()` shape.** The `FakeVaultClient` lookup uses `String(fn)` to key responses. Confirm the runtime output of stringifying a generated FunctionReference (e.g. `String(api.subscriptions.queries.listForUser)`) — Convex's proxy emits a path string but the format ("subscriptions:listForUser" vs "subscriptions/queries:listForUser") needs verification at impl-time. If the format is unstable, switch the fake to key on object identity instead.

4. **Yarn workspaces vs standalone `cli/package.json`.** Should `cli/` be a yarn workspace (root `package.json` adds `"workspaces": ["cli", "frontend"]`) or a standalone Bun-managed package? Workspaces are simpler for shared deps. Bun-managed is simpler for the binary build. Recommend: workspaces (since root already uses yarn 4 with PnP-disabled — verify `.yarnrc.yml`). The CLI just adds `bun` for the build step; install stays under yarn.

5. **`.gitignore` updates.** Add `cli/dist/` and `cli/node_modules/` to root `.gitignore`. Do not commit binaries.

6. **Code-signing decision deferred.** v1 ships unsigned macOS binaries with quarantine-removal docs in README. v2: Apple Developer ID + notarization → flip a flag in the GH Actions workflow to run `codesign` and `notarytool`. Cost: $99/year + setup overhead.

7. **Convex deployment URL discovery.** Same as the Python brief: hard-code prod URL in `cli/src/index.ts` with `CVAULT_CONVEX_URL` env override; document in README.

8. **`claude-swap --add-account` post-condition discovery.** After `addAccountInteractive()` returns, we need to know which slot was just added. `claude-swap --status` returns the active slot, but if `--add-account` doesn't auto-switch, we may need a different probe. Verify against `claude-swap` v0.10.x behavior at impl-time (read its `cli.py`).

9. **`yarn` vs `bun install` in the CLI.** The root uses yarn 4 (`packageManager: yarn@4.13.0`). The CLI's own deps install fine under yarn workspaces. Bun is only required for the build step (`bun build --compile`). If we want the CLI to install fine without yarn (e.g. for contributors who clone only the cli/ folder), keep the cli/package.json as a standalone npm package. Recommend: standalone for v1 — it's a portable CLI, not coupled to the monorepo's package install.

10. **Per-machine `User-Agent` for Clerk activity.** `clerk-convex-tanstack-integration.md` §6 calls out that the dashboard should label sessions as "cvault CLI". `cliUserAgent()` (§5.2) builds the UA but does not include a hostname (`os.hostname()`) — confirm whether including hostname leaks info we don't want; if OK, append `; host=<hostname>` for dashboard display.

11. **Session perms check on Windows.** `(stats.mode & 0o077) !== 0` is meaningful on POSIX only. On Windows, perms work differently. v1 is Mac-first per spec §2; document this in `readSession()` as a comment. v2 (if we add Windows): use `winston` perms check or skip the check on `process.platform === 'win32'`.

---

## 11. File paths in this brief

- This brief: `/Users/saadings/Desktop/cvault/docs/research/ts-bun-cli-tooling.md`
- Source spec: `/Users/saadings/Desktop/cvault/docs/superpowers/specs/2026-05-02-cvault-design.md`
- Auth flow brief (still authoritative for the flow shape): `/Users/saadings/Desktop/cvault/docs/research/clerk-convex-tanstack-integration.md`
- Anthropic brief (language-agnostic, still authoritative): `/Users/saadings/Desktop/cvault/docs/research/anthropic-oauth-refresh.md`, `/Users/saadings/Desktop/cvault/docs/research/anthropic-usage.md`
- Discarded but envelope shape still correct: `/Users/saadings/Desktop/cvault/docs/research/python-cli-tooling.md` (specifically §3's `claudeAiOauth` envelope)

## 12. Documentation references

- Bun build executables: <https://bun.sh/docs/bundler/executables>
- Bun bytecode: <https://bun.sh/docs/bundler/bytecode>
- Bun spawn: <https://bun.sh/docs/api/spawn>
- Bun serve: <https://bun.sh/docs/api/http>
- Bun shell: <https://bun.sh/docs/runtime/shell>
- bunx: <https://bun.sh/docs/cli/bunx>
- citty: <https://github.com/unjs/citty>
- Convex `ConvexHttpClient`: <https://docs.convex.dev/api/classes/browser.ConvexHttpClient>
- Convex JS clients: <https://docs.convex.dev/client/javascript>
- Convex auth & HTTP: <https://docs.convex.dev/auth/functions-auth>
- `@clerk/backend` (sessions, verifyToken): see existing `clerk-convex-tanstack-integration.md` §6 + Clerk JS SDK source
- Clerk FAPI sign-in tokens / ticket strategy: see existing `clerk-convex-tanstack-integration.md` §4-5
- Homebrew custom tap formulae: <https://docs.brew.sh/Formula-Cookbook>, <https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap>
- GitHub Actions matrix builds: <https://docs.github.com/en/actions/using-jobs/using-a-matrix-for-your-jobs>
- `softprops/action-gh-release`: <https://github.com/softprops/action-gh-release>
- `oven-sh/setup-bun`: <https://github.com/oven-sh/setup-bun>
