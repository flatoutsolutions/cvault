/**
 * Platform detection for the native credential module.
 *
 * Mirrors `claude-swap`'s `Platform.detect()` so the on-disk credentials
 * layout this module reads/writes matches what `claude-swap` (and Claude
 * Code itself) used. WSL is detected via the `WSL_DISTRO_NAME` env var, the
 * standard Microsoft-recommended sentinel.
 */

export type Platform = 'macos' | 'linux' | 'wsl' | 'windows' | 'unknown'

export function getPlatform(): Platform {
  switch (process.platform) {
    case 'darwin':
      return 'macos'
    case 'linux': {
      const wsl = process.env.WSL_DISTRO_NAME
      return wsl !== undefined && wsl.length > 0 ? 'wsl' : 'linux'
    }
    case 'win32':
      return 'windows'
    default:
      return 'unknown'
  }
}
