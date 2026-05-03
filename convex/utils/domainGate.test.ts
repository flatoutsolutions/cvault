import { describe, expect, it } from 'vitest'

import {
  ALLOWED_EMAIL_DOMAIN,
  DOMAIN_REJECTION_ERROR_CODE,
  DOMAIN_REJECTION_MESSAGE,
  isAllowedEmail,
} from './domainGate'

describe('domainGate', () => {
  describe('ALLOWED_EMAIL_DOMAIN', () => {
    it('is the FlatOut Solutions domain', () => {
      expect(ALLOWED_EMAIL_DOMAIN).toBe('flatout.solutions')
    })
  })

  describe('DOMAIN_REJECTION_ERROR_CODE', () => {
    it('is a stable string identifier', () => {
      expect(DOMAIN_REJECTION_ERROR_CODE).toBe('EMAIL_DOMAIN_NOT_ALLOWED')
    })
  })

  describe('DOMAIN_REJECTION_MESSAGE', () => {
    it('mentions the domain', () => {
      expect(DOMAIN_REJECTION_MESSAGE).toMatch(/flatout\.solutions/)
    })
  })

  describe('isAllowedEmail', () => {
    it('accepts canonical FlatOut Solutions email', () => {
      expect(isAllowedEmail('alice@flatout.solutions')).toBe(true)
    })

    it('accepts uppercase variants (case-insensitive)', () => {
      expect(isAllowedEmail('Alice@FlatOut.Solutions')).toBe(true)
      expect(isAllowedEmail('ALICE@FLATOUT.SOLUTIONS')).toBe(true)
    })

    it('accepts plus-tag addresses on the allowed domain', () => {
      expect(isAllowedEmail('alice+work@flatout.solutions')).toBe(true)
    })

    it('rejects different TLD', () => {
      expect(isAllowedEmail('alice@flatout.com')).toBe(false)
    })

    it('rejects subdomain attack', () => {
      expect(isAllowedEmail('alice@evil.flatout.solutions')).toBe(false)
    })

    it('rejects domain-suffix attack', () => {
      expect(isAllowedEmail('alice@flatout.solutions.attacker.com')).toBe(false)
    })

    it('rejects similar-but-different domains', () => {
      expect(isAllowedEmail('alice@gmail.com')).toBe(false)
      expect(isAllowedEmail('alice@flatout.io')).toBe(false)
    })

    it('rejects empty, null, undefined', () => {
      expect(isAllowedEmail('')).toBe(false)
      expect(isAllowedEmail(null)).toBe(false)
      expect(isAllowedEmail(undefined)).toBe(false)
    })

    it('rejects malformed values lacking @', () => {
      expect(isAllowedEmail('aliceflatout.solutions')).toBe(false)
      expect(isAllowedEmail('alice')).toBe(false)
    })

    it('rejects whitespace-padded values (does not trim)', () => {
      // We do not trim — Clerk should never give us padded emails. Reject defensively.
      expect(isAllowedEmail(' alice@flatout.solutions ')).toBe(false)
    })
  })
})
