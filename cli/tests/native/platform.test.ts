/**
 * Platform detection for the native credential module.
 *
 * Mirrors claude-swap's `Platform.detect()` so cvault's behavior on each
 * OS matches what users got with the Python tool. The only twist is WSL:
 * `process.platform === 'linux'` AND `WSL_DISTRO_NAME` is set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getPlatform } from '../../src/native/platform'

describe('getPlatform', () => {
  let originalPlatform: NodeJS.Platform

  beforeEach(() => {
    originalPlatform = process.platform
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.unstubAllEnvs()
  })

  it('returns "macos" on darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect(getPlatform()).toBe('macos')
  })

  it('returns "linux" on linux without WSL_DISTRO_NAME', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    vi.stubEnv('WSL_DISTRO_NAME', '')
    expect(getPlatform()).toBe('linux')
  })

  it('returns "wsl" on linux when WSL_DISTRO_NAME is set', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu-22.04')
    expect(getPlatform()).toBe('wsl')
  })

  it('returns "windows" on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(getPlatform()).toBe('windows')
  })

  it('returns "unknown" on other platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true })
    expect(getPlatform()).toBe('unknown')
  })
})
