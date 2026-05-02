import { describe, expect, it } from 'vitest'

import { redactTokens } from './redact'

describe('redactTokens', () => {
  it('redacts an Anthropic OAuth access token shape', () => {
    const input = 'oauth call failed: sk-ant-oat01-AAABBBCCC_DDD-EEE-FFF99999000 returned 401'
    expect(redactTokens(input)).toBe('oauth call failed: <redacted> returned 401')
  })

  it('redacts an Anthropic OAuth refresh token shape', () => {
    const input = 'token rotated to sk-ant-ort01-XYZ_abcDEFghi123456789ABC for sub'
    expect(redactTokens(input)).toBe('token rotated to <redacted> for sub')
  })

  it('redacts multiple tokens in the same string', () => {
    const input = 'old=sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAA new=sk-ant-ort01-BBBBBBBBBBBBBBBBBBBBBB'
    expect(redactTokens(input)).toBe('old=<redacted> new=<redacted>')
  })

  it('leaves messages without tokens untouched', () => {
    const input = 'Anthropic returned 503 service unavailable'
    expect(redactTokens(input)).toBe('Anthropic returned 503 service unavailable')
  })

  it('returns the empty string for an empty input', () => {
    expect(redactTokens('')).toBe('')
  })
})
