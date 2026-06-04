import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { base64UrlEncode, codeChallengeS256, generateCodeVerifier } from '../../src/auth/pkce'

describe('pkce', () => {
  it('generateCodeVerifier returns a URL-safe string 43-128 chars', () => {
    const v = generateCodeVerifier()
    expect(v).toMatch(/^[A-Za-z0-9\-_]{43,128}$/)
  })
  it('codeChallengeS256 is base64url(sha256(verifier))', () => {
    const verifier = 'test-verifier'
    const expected = base64UrlEncode(createHash('sha256').update(verifier).digest())
    expect(codeChallengeS256(verifier)).toBe(expected)
  })
})
