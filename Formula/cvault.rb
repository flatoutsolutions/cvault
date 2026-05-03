# typed: false
# frozen_string_literal: true

# =============================================================================
#  cvault — Centralized Claude Code Credential Vault
# -----------------------------------------------------------------------------
#  This file is the canonical Homebrew formula for `cvault`. The `update-tap`
#  job in .github/workflows/release-cli.yml copies this template into the
#  homebrew tap repo (flatoutsolutions/homebrew-cvault) and substitutes:
#
#    * the `version "..."` line
#    * the `sha256 "..."` line below
#
#  Hand-edits to the placeholder markers will get clobbered by CI on the next
#  release. Edit structure, descriptions, caveats here; never edit hashes.
#
#  Distribution model (per docs/superpowers/specs/2026-05-03-cvault-production-deployment.md):
#  Bun's `--compile` Mach-O output is unsignable on macOS (Bun 1.3.12 bug),
#  so cvault ships as a single bundled `cvault.bundle.js` plus a thin bash
#  shim that `exec`s it through homebrew's `bun`. One artifact for every
#  platform — no per-OS or per-arch matrix.
# =============================================================================
class Cvault < Formula
  desc "Centralized Claude Code credential vault — Mac Keychain sync via Convex"
  homepage "https://github.com/flatoutsolutions/cvault"
  url "https://github.com/flatoutsolutions/cvault/releases/download/cli-v#{version}/cvault.bundle.js.tar.gz"
  # Bumped automatically by .github/workflows/release-cli.yml.
  version "0.1.0"
  # CI substitutes the marker on each release. DO NOT hand-edit.
  sha256 "SHA256_BUNDLE_PLACEHOLDER"
  license "MIT"

  # The bundle is plain JavaScript — Bun is the only runtime dependency.
  # Homebrew already has a maintained `bun` formula on both macOS and
  # Linuxbrew, so leaning on it instead of vendoring a copy keeps cvault
  # tiny and lets users pick up Bun upgrades automatically.
  depends_on "bun"

  def install
    # The release tarball contains a single file: cvault.bundle.js. Drop
    # it into libexec (Homebrew convention for non-PATH-exposed assets)
    # and synthesize a tiny bash wrapper at bin/cvault that calls bun on
    # it. The wrapper has the resolved absolute paths to bun + bundle
    # baked in at install time, so it works correctly regardless of the
    # user's PATH ordering or shell.
    libexec.install "cvault.bundle.js"
    (bin / "cvault").write <<~SHIM
      #!/bin/bash
      exec "#{Formula["bun"].opt_bin}/bun" "#{libexec}/cvault.bundle.js" "$@"
    SHIM
    chmod 0755, bin / "cvault"
  end

  # ---------------------------------------------------------------------------
  # Caveats — printed once after `brew install` and on every `brew info cvault`.
  # First-time setup hint for new installs.
  # ---------------------------------------------------------------------------
  def caveats
    <<~EOS
      First-time setup:

          cvault login        # browser-assisted Clerk sign-in
          cvault add          # capture the currently-active Claude Code login
          cvault list         # verify it landed in the vault

      `cvault add` requires the `claude` CLI on PATH (Claude Code itself).
    EOS
  end

  # ---------------------------------------------------------------------------
  # Sanity check — `brew test cvault` invokes this. Keep it cheap (no network,
  # no Convex round-trip). Both flags must work on a fresh install with no
  # `~/.vault/` config present.
  #
  # `--version` prints only the bare version string (e.g. "0.1.0"), so we
  # compare against a semver-ish regex rather than asserting the binary name
  # appears. `--help` is the dependable place to grep for "cvault".
  # ---------------------------------------------------------------------------
  test do
    assert_match(/^\d+\.\d+\.\d+/, shell_output("#{bin}/cvault --version"))
    assert_match "cvault", shell_output("#{bin}/cvault --help")
  end
end
