# typed: false
# frozen_string_literal: true

# =============================================================================
#  cvault — Centralized Claude Code Credential Vault
# -----------------------------------------------------------------------------
#  This file is the canonical Homebrew formula for `cvault`. The `update-tap`
#  job in .github/workflows/release-cli.yml copies this template into the
#  homebrew tap repo (TODO: stefanasseg/homebrew-cvault) and substitutes:
#
#    * the `version "..."` line
#    * the four `SHA256_<platform>_PLACEHOLDER` markers below
#
#  Hand-edits to the placeholder markers will get clobbered by CI on the next
#  release. Edit structure, descriptions, caveats here; never edit hashes.
# =============================================================================
class Cvault < Formula
  desc "Centralized Claude Code credential vault — sync OAuth across machines"
  homepage "https://github.com/stefanasseg/cvault"
  # Confirm: spec does not state a license. MIT is the assumed default.
  # If a LICENSE file is added with a different license, update this stanza
  # AND note it in IMPLEMENTATION_NOTES.
  license "MIT"
  # Bumped automatically by .github/workflows/release-cli.yml.
  version "0.1.0"

  # ---------------------------------------------------------------------------
  # macOS
  # ---------------------------------------------------------------------------
  on_macos do
    on_arm do
      url "https://github.com/stefanasseg/cvault/releases/download/cli-v#{version}/cvault-darwin-arm64"
      # CI substitutes the marker on each release. DO NOT hand-edit.
      sha256 "SHA256_DARWIN_ARM64_PLACEHOLDER"

      def install
        # The release asset is the bare static binary produced by
        # `bun build --compile --target=bun-darwin-arm64`. Mark executable
        # and rename to the canonical command name.
        chmod 0755, "cvault-darwin-arm64"
        bin.install "cvault-darwin-arm64" => "cvault"
      end
    end

    on_intel do
      url "https://github.com/stefanasseg/cvault/releases/download/cli-v#{version}/cvault-darwin-x64"
      sha256 "SHA256_DARWIN_X64_PLACEHOLDER"

      def install
        chmod 0755, "cvault-darwin-x64"
        bin.install "cvault-darwin-x64" => "cvault"
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Linux
  # ---------------------------------------------------------------------------
  on_linux do
    on_intel do
      url "https://github.com/stefanasseg/cvault/releases/download/cli-v#{version}/cvault-linux-x64"
      sha256 "SHA256_LINUX_X64_PLACEHOLDER"

      def install
        chmod 0755, "cvault-linux-x64"
        bin.install "cvault-linux-x64" => "cvault"
      end
    end

    on_arm do
      url "https://github.com/stefanasseg/cvault/releases/download/cli-v#{version}/cvault-linux-arm64"
      sha256 "SHA256_LINUX_ARM64_PLACEHOLDER"

      def install
        chmod 0755, "cvault-linux-arm64"
        bin.install "cvault-linux-arm64" => "cvault"
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Sanity check — `brew test cvault` invokes this. Keep it cheap (no network,
  # no Convex round-trip). The version flag must work on a fresh install with
  # no `~/.vault/` config present.
  # ---------------------------------------------------------------------------
  test do
    assert_match "cvault", shell_output("#{bin}/cvault --version")
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
end
