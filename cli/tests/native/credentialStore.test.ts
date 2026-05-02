/**
 * Facade dispatching credential ops to the right backend per platform.
 *
 * - macOS → keychain.ts
 * - Linux/WSL → credentialsFile.ts
 * - Windows → throws PlatformUnsupportedError (deferred to v2)
 *
 * The facade is thin — it imports both backends and routes by
 * `getPlatform()`. We mock the backends so dispatch is observable without
 * touching the real Keychain or filesystem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteCredentialsFile, readCredentialsFile, writeCredentialsFile } from '../../src/native/credentialsFile'
import {
  deleteActiveCredentials as kcDelete,
  readActiveCredentials,
  writeActiveCredentials,
} from '../../src/native/keychain'

vi.mock('../../src/native/keychain', () => ({
  KEYCHAIN_SERVICE: 'Claude Code-credentials',
  readActiveCredentials: vi.fn(),
  writeActiveCredentials: vi.fn(),
  deleteActiveCredentials: vi.fn(),
}))

vi.mock('../../src/native/credentialsFile', () => ({
  readCredentialsFile: vi.fn(),
  writeCredentialsFile: vi.fn(),
  deleteCredentialsFile: vi.fn(),
}))

let originalPlatform: NodeJS.Platform

beforeEach(() => {
  originalPlatform = process.platform
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  vi.unstubAllEnvs()
})

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

describe('readCredentials', () => {
  it('dispatches to keychain on darwin', async () => {
    setPlatform('darwin')
    vi.mocked(readActiveCredentials).mockReturnValueOnce('mac-blob')
    const { readCredentials } = await import('../../src/native/credentialStore')
    expect(readCredentials()).toBe('mac-blob')
    expect(readActiveCredentials).toHaveBeenCalledOnce()
  })

  it('dispatches to credentialsFile on linux without WSL_DISTRO_NAME', async () => {
    setPlatform('linux')
    vi.stubEnv('WSL_DISTRO_NAME', '')
    vi.mocked(readCredentialsFile).mockReturnValueOnce('linux-blob')
    const { readCredentials } = await import('../../src/native/credentialStore')
    expect(readCredentials()).toBe('linux-blob')
    expect(readCredentialsFile).toHaveBeenCalledOnce()
  })

  it('dispatches to credentialsFile on linux with WSL_DISTRO_NAME (wsl)', async () => {
    setPlatform('linux')
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu-22.04')
    vi.mocked(readCredentialsFile).mockReturnValueOnce('wsl-blob')
    const { readCredentials } = await import('../../src/native/credentialStore')
    expect(readCredentials()).toBe('wsl-blob')
    expect(readCredentialsFile).toHaveBeenCalledOnce()
  })

  it('throws PlatformUnsupportedError on win32', async () => {
    setPlatform('win32')
    const { readCredentials } = await import('../../src/native/credentialStore')
    expect(() => readCredentials()).toThrow(/does not yet support/i)
  })
})

describe('writeCredentials', () => {
  it('dispatches to keychain on darwin', async () => {
    setPlatform('darwin')
    const { writeCredentials } = await import('../../src/native/credentialStore')
    writeCredentials('blob-1')
    expect(writeActiveCredentials).toHaveBeenCalledWith('blob-1')
  })

  it('dispatches to credentialsFile on linux', async () => {
    setPlatform('linux')
    vi.stubEnv('WSL_DISTRO_NAME', '')
    const { writeCredentials } = await import('../../src/native/credentialStore')
    writeCredentials('blob-2')
    expect(writeCredentialsFile).toHaveBeenCalledWith('blob-2')
  })

  it('throws PlatformUnsupportedError on win32', async () => {
    setPlatform('win32')
    const { writeCredentials } = await import('../../src/native/credentialStore')
    expect(() => writeCredentials('x')).toThrow(/does not yet support/i)
  })
})

describe('deleteCredentials', () => {
  it('dispatches to keychain.deleteActiveCredentials on darwin', async () => {
    setPlatform('darwin')
    const { deleteCredentials } = await import('../../src/native/credentialStore')
    deleteCredentials()
    expect(kcDelete).toHaveBeenCalledOnce()
  })

  it('dispatches to credentialsFile on linux', async () => {
    setPlatform('linux')
    vi.stubEnv('WSL_DISTRO_NAME', '')
    const { deleteCredentials } = await import('../../src/native/credentialStore')
    deleteCredentials()
    expect(deleteCredentialsFile).toHaveBeenCalledOnce()
  })

  it('throws PlatformUnsupportedError on win32', async () => {
    setPlatform('win32')
    const { deleteCredentials } = await import('../../src/native/credentialStore')
    expect(() => deleteCredentials()).toThrow(/does not yet support/i)
  })
})
