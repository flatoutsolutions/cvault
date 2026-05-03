import { describe, expect, it } from 'vitest'

import {
  BOOTSTRAP_ALLOWED_DOMAINS,
  DOMAIN_REJECTION_ERROR_CODE,
  DOMAIN_REJECTION_MESSAGE,
  isAllowedEmail,
  isValidDomain,
  normalizeDomain,
} from './domainGate'

describe('domainGate', () => {
  describe('BOOTSTRAP_ALLOWED_DOMAINS', () => {
    it('contains flatout.solutions', () => {
      expect(BOOTSTRAP_ALLOWED_DOMAINS).toContain('flatout.solutions')
    })
    it('is readonly array of lowercase strings', () => {
      for (const d of BOOTSTRAP_ALLOWED_DOMAINS) expect(d).toBe(d.toLowerCase())
    })
  })

  describe('DOMAIN_REJECTION_ERROR_CODE', () => {
    it('is EMAIL_DOMAIN_NOT_ALLOWED', () => {
      expect(DOMAIN_REJECTION_ERROR_CODE).toBe('EMAIL_DOMAIN_NOT_ALLOWED')
    })
  })

  describe('DOMAIN_REJECTION_MESSAGE', () => {
    it('mentions allowed/domain', () => {
      expect(DOMAIN_REJECTION_MESSAGE).toMatch(/domain/i)
    })
  })

  describe('isAllowedEmail', () => {
    const FLATOUT = ['flatout.solutions'] as const

    it('accepts canonical', () => {
      expect(isAllowedEmail('alice@flatout.solutions', FLATOUT)).toBe(true)
    })
    it('case-insensitive', () => {
      expect(isAllowedEmail('Alice@FlatOut.Solutions', FLATOUT)).toBe(true)
      expect(isAllowedEmail('ALICE@FLATOUT.SOLUTIONS', FLATOUT)).toBe(true)
    })
    it('plus-tag', () => {
      expect(isAllowedEmail('alice+work@flatout.solutions', FLATOUT)).toBe(true)
    })
    it('rejects different TLD', () => {
      expect(isAllowedEmail('alice@flatout.com', FLATOUT)).toBe(false)
    })
    it('rejects subdomain attack', () => {
      expect(isAllowedEmail('alice@evil.flatout.solutions', FLATOUT)).toBe(false)
    })
    it('rejects suffix attack', () => {
      expect(isAllowedEmail('alice@flatout.solutions.attacker.com', FLATOUT)).toBe(false)
    })
    it('rejects empty list', () => {
      expect(isAllowedEmail('alice@flatout.solutions', [])).toBe(false)
    })
    it('multi-domain', () => {
      const list = ['flatout.solutions', 'acme.com']
      expect(isAllowedEmail('alice@acme.com', list)).toBe(true)
      expect(isAllowedEmail('alice@flatout.solutions', list)).toBe(true)
      expect(isAllowedEmail('alice@gmail.com', list)).toBe(false)
    })
    it('rejects empty/null/undefined', () => {
      expect(isAllowedEmail('', FLATOUT)).toBe(false)
      expect(isAllowedEmail(null, FLATOUT)).toBe(false)
      expect(isAllowedEmail(undefined, FLATOUT)).toBe(false)
    })
    it('rejects malformed', () => {
      expect(isAllowedEmail('aliceflatout.solutions', FLATOUT)).toBe(false)
      expect(isAllowedEmail('alice', FLATOUT)).toBe(false)
    })
    it('rejects whitespace-padded', () => {
      expect(isAllowedEmail(' alice@flatout.solutions ', FLATOUT)).toBe(false)
    })
    it('handles uppercase domain in list (defensive)', () => {
      expect(isAllowedEmail('alice@flatout.solutions', ['FLATOUT.SOLUTIONS'])).toBe(true)
    })
  })

  describe('normalizeDomain', () => {
    it('lowercases', () => {
      expect(normalizeDomain('FlatOut.Solutions')).toBe('flatout.solutions')
    })
    it('trims', () => {
      expect(normalizeDomain('  acme.com  ')).toBe('acme.com')
    })
    it('strips leading @', () => {
      expect(normalizeDomain('@acme.com')).toBe('acme.com')
    })
    it('combo', () => {
      expect(normalizeDomain('  @ACME.com  ')).toBe('acme.com')
    })
  })

  describe('isValidDomain', () => {
    it('accepts simple', () => {
      expect(isValidDomain('acme.com')).toBe(true)
      expect(isValidDomain('flatout.solutions')).toBe(true)
      expect(isValidDomain('example.co.uk')).toBe(true)
    })
    it('rejects no dot', () => {
      expect(isValidDomain('acme')).toBe(false)
    })
    it('rejects leading @', () => {
      expect(isValidDomain('@acme.com')).toBe(false)
    })
    it('rejects double dots', () => {
      expect(isValidDomain('a..b')).toBe(false)
    })
    it('rejects spaces', () => {
      expect(isValidDomain('acme com')).toBe(false)
    })
    it('rejects empty', () => {
      expect(isValidDomain('')).toBe(false)
    })
  })
})
