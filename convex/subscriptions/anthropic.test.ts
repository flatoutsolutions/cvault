import { describe, expect, it } from 'vitest'

import { USER_AGENT } from './anthropic'

describe('USER_AGENT', () => {
  it('points at the canonical flatoutsolutions/cvault repo', () => {
    expect(USER_AGENT).toContain('flatoutsolutions/cvault')
  })

  it('does not reference the old saadings/cvault repo', () => {
    expect(USER_AGENT).not.toContain('saadings/cvault')
  })

  it('matches the expected format', () => {
    expect(USER_AGENT).toMatch(/^cvault\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/flatoutsolutions\/cvault\)$/)
  })
})
