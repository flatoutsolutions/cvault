/**
 * Spec: §6, §10 — token-shape redaction so OAuth tokens never reach logs.
 *
 * Mirror of the Convex-side `convex/subscriptions/redact.ts` test contract.
 * The CLI side needs the same regex because we log error messages locally
 * (e.g. when `claude-swap` stderr contains a stale token).
 */
import { describe, expect, it } from 'vitest'

import { redactTokens } from '../../src/render/redact'

describe('redactTokens', () => {
  it('returns the input unchanged when no token-shaped substrings are present', () => {
    expect(redactTokens('hello world')).toBe('hello world')
    expect(redactTokens('')).toBe('')
  })

  it('redacts an Anthropic OAuth access-token-shaped substring', () => {
    const input = 'failed: sk-ant-oat01-AbCdEfGhIjKlMnOpQrSt12345 was rejected'
    expect(redactTokens(input)).toBe('failed: <redacted> was rejected')
  })

  it('redacts an Anthropic OAuth refresh-token-shaped substring', () => {
    const input = 'using sk-ant-ort01-ZyXwVuTsRqPoNmLkJiHg9876543 to refresh'
    expect(redactTokens(input)).toBe('using <redacted> to refresh')
  })

  it('redacts every match in a multi-token string', () => {
    const input =
      'access=sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA refresh=sk-ant-ort01-BBBBBBBBBBBBBBBBBBBB done'
    expect(redactTokens(input)).toBe('access=<redacted> refresh=<redacted> done')
  })

  it('does not redact non-token text containing the prefix', () => {
    // Too short — the regex requires at least 20 base64-ish chars after the dash.
    expect(redactTokens('sk-ant-oat01-short')).toBe('sk-ant-oat01-short')
    expect(redactTokens('sk-ant-')).toBe('sk-ant-')
  })
})
