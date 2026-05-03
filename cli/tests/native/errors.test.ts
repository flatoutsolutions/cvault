/**
 * Tests for the native module's typed errors.
 *
 * The error classes are the boundary between the native credential code and
 * the rest of cvault. Top-level handlers narrow on these to print clear
 * remediation hints (e.g. "install the `claude` CLI", "Windows is not
 * supported in v1").
 */
import { describe, expect, it } from 'vitest'

import { ClaudeCliMissingError, NativeKeychainError, PlatformUnsupportedError } from '../../src/native/errors'

describe('NativeKeychainError', () => {
  it('is an Error subclass with the right name', () => {
    const e = new NativeKeychainError('boom', 1, 'stderr-text')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('NativeKeychainError')
    expect(e.message).toBe('boom')
    expect(e.exitCode).toBe(1)
    expect(e.stderr).toBe('stderr-text')
  })

  it('accepts a null exitCode for spawn-failure cases', () => {
    const e = new NativeKeychainError('exec failed', null, '')
    expect(e.exitCode).toBeNull()
  })
})

describe('ClaudeCliMissingError', () => {
  it('produces a clear install hint mentioning `claude`', () => {
    const e = new ClaudeCliMissingError()
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ClaudeCliMissingError')
    expect(e.message).toMatch(/claude/i)
    expect(e.message).toMatch(/install|PATH/i)
  })
})

describe('PlatformUnsupportedError', () => {
  it('names the unsupported platform in the message', () => {
    const e = new PlatformUnsupportedError('win32')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('PlatformUnsupportedError')
    expect(e.message).toMatch(/win32/)
  })
})
