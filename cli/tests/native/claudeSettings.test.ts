import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  addUserPromptSubmitHook,
  installPullHook,
  readSettings,
  removeUserPromptSubmitHook,
} from '../../src/native/claudeSettings'

const CMD = '/opt/homebrew/bin/cvault pull'

describe('addUserPromptSubmitHook', () => {
  it('adds a synchronous command hook, preserving other keys', () => {
    const out = addUserPromptSubmitHook({ theme: 'dark', hooks: { Stop: [{ matcher: '.*', hooks: [] }] } }, CMD)
    expect(out.theme).toBe('dark')
    expect(out.hooks?.Stop).toHaveLength(1)
    expect(out.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]).toEqual({ type: 'command', command: CMD })
  })

  it('is idempotent — does not add the same command twice', () => {
    const once = addUserPromptSubmitHook({}, CMD)
    const twice = addUserPromptSubmitHook(once, CMD)
    expect(twice.hooks?.UserPromptSubmit).toHaveLength(1)
  })
})

describe('removeUserPromptSubmitHook', () => {
  it('removes only our command, leaving others intact', () => {
    const withTwo = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'other' }] },
          { hooks: [{ type: 'command', command: CMD }] },
        ],
      },
    }
    const out = removeUserPromptSubmitHook(withTwo, CMD)
    expect(out.hooks?.UserPromptSubmit).toHaveLength(1)
    expect(out.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe('other')
  })

  it('drops the UserPromptSubmit key entirely when no groups remain', () => {
    const out = removeUserPromptSubmitHook(
      { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: CMD }] }] } },
      CMD
    )
    expect(out.hooks?.UserPromptSubmit).toBeUndefined()
  })
})

describe('readSettings (on-disk)', () => {
  let dir: string
  const ORIGINAL = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cvault-settings-'))
    process.env.CLAUDE_CONFIG_DIR = dir
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (ORIGINAL === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL
  })

  it('returns an empty object when settings.json does not exist', () => {
    expect(readSettings()).toEqual({})
  })

  it('parses a valid settings.json', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    expect(readSettings().theme).toBe('dark')
  })

  it('throws an actionable error (path + "valid JSON") on a malformed settings.json', () => {
    // A raw SyntaxError ("Unexpected token") would leave the user with no idea
    // WHICH file is broken or that it silently disabled the pull hook.
    writeFileSync(join(dir, 'settings.json'), '{ "hooks": , }')
    expect(() => readSettings()).toThrow(/settings\.json.*valid JSON/i)
    expect(() => readSettings()).toThrow(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  it('installPullHook surfaces the actionable error on a malformed settings.json', async () => {
    writeFileSync(join(dir, 'settings.json'), 'not json at all')
    await expect(installPullHook(CMD)).rejects.toThrow(/settings\.json.*valid JSON/i)
  })
})
