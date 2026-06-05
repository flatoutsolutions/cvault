import { describe, expect, it } from 'vitest'

import { addUserPromptSubmitHook, removeUserPromptSubmitHook } from '../../src/native/claudeSettings'

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
