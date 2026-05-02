/**
 * Platform-dispatching facade for the active Claude Code credentials.
 *
 * Routes:
 *  - macOS                   → `keychain.ts`
 *  - Linux / WSL             → `credentialsFile.ts`
 *  - Windows / unknown       → throws `PlatformUnsupportedError`
 *
 * Callers should import from this module rather than the per-platform
 * backends directly. Phase B (after the migration is verified) may revisit
 * whether to expose the backends — but `cvault add`/`switch`/`remove` only
 * need the platform-agnostic surface.
 */
import { deleteCredentialsFile, readCredentialsFile, writeCredentialsFile } from './credentialsFile'
import { PlatformUnsupportedError } from './errors'
import { deleteActiveCredentials, readActiveCredentials, writeActiveCredentials } from './keychain'
import { getPlatform } from './platform'

/**
 * Read the currently-active credentials blob. Returns `null` when no
 * credentials are stored on this machine (fresh install / post-clean).
 */
export function readCredentials(): string | null {
  const p = getPlatform()
  switch (p) {
    case 'macos':
      return readActiveCredentials()
    case 'linux':
    case 'wsl':
      return readCredentialsFile()
    case 'windows':
    case 'unknown':
      throw new PlatformUnsupportedError(p === 'unknown' ? process.platform : 'windows')
  }
}

/** Persist the credentials blob, replacing any prior value. */
export function writeCredentials(blob: string): void {
  const p = getPlatform()
  switch (p) {
    case 'macos':
      writeActiveCredentials(blob)
      return
    case 'linux':
    case 'wsl':
      writeCredentialsFile(blob)
      return
    case 'windows':
    case 'unknown':
      throw new PlatformUnsupportedError(p === 'unknown' ? process.platform : 'windows')
  }
}

/** Remove the credentials blob. Idempotent on all backends. */
export function deleteCredentials(): void {
  const p = getPlatform()
  switch (p) {
    case 'macos':
      deleteActiveCredentials()
      return
    case 'linux':
    case 'wsl':
      deleteCredentialsFile()
      return
    case 'windows':
    case 'unknown':
      throw new PlatformUnsupportedError(p === 'unknown' ? process.platform : 'windows')
  }
}
