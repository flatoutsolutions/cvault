/**
 * Path resolution for Claude Code config + credentials.
 *
 * Mirrors `claude-swap/paths.py` exactly because Claude Code itself reads
 * these paths and we must read/write the same files Claude Code does. The
 * tricky case is the global config: by default `.claude.json` sits at
 * `$HOME` (NOT inside `.claude/`), but if `CLAUDE_CONFIG_DIR` is set, the
 * file moves with it. The legacy `<config_home>/.config.json` takes
 * precedence over either when present.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getClaudeConfigHome, getCredentialsFilePath, getGlobalConfigPath } from '../../src/native/paths'

let tempHome: string

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-paths-test-'))
  vi.stubEnv('HOME', tempHome)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
})

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('getClaudeConfigHome', () => {
  it('returns CLAUDE_CONFIG_DIR when set', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/custom-claude')
    expect(getClaudeConfigHome()).toBe('/tmp/custom-claude')
  })

  it('falls back to $HOME/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    expect(getClaudeConfigHome()).toBe(join(tempHome, '.claude'))
  })
})

describe('getGlobalConfigPath', () => {
  it('returns $HOME/.claude.json when no CLAUDE_CONFIG_DIR and no legacy file', () => {
    expect(getGlobalConfigPath()).toBe(join(tempHome, '.claude.json'))
  })

  it('returns CLAUDE_CONFIG_DIR/.claude.json when CLAUDE_CONFIG_DIR is set', () => {
    const customDir = join(tempHome, 'custom-claude')
    vi.stubEnv('CLAUDE_CONFIG_DIR', customDir)
    expect(getGlobalConfigPath()).toBe(join(customDir, '.claude.json'))
  })

  it('prefers <config_home>/.config.json (legacy) when it exists', () => {
    // claude-swap's paths.py:42-53 — legacy `.config.json` inside the
    // config home wins over the modern `.claude.json` at homedir.
    const claudeDir = join(tempHome, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    const legacyPath = join(claudeDir, '.config.json')
    writeFileSync(legacyPath, '{}')

    expect(getGlobalConfigPath()).toBe(legacyPath)
  })

  it('legacy precedence still wins when CLAUDE_CONFIG_DIR is set', () => {
    const customDir = join(tempHome, 'custom-claude')
    mkdirSync(customDir, { recursive: true })
    const legacyPath = join(customDir, '.config.json')
    writeFileSync(legacyPath, '{}')
    vi.stubEnv('CLAUDE_CONFIG_DIR', customDir)

    expect(getGlobalConfigPath()).toBe(legacyPath)
  })
})

describe('getCredentialsFilePath', () => {
  it('returns <claude config home>/.credentials.json', () => {
    expect(getCredentialsFilePath()).toBe(join(tempHome, '.claude', '.credentials.json'))
  })

  it('respects CLAUDE_CONFIG_DIR', () => {
    const customDir = join(tempHome, 'custom-claude')
    vi.stubEnv('CLAUDE_CONFIG_DIR', customDir)
    expect(getCredentialsFilePath()).toBe(join(customDir, '.credentials.json'))
  })
})
