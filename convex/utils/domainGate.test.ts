import { describe, expect, it } from 'vitest'

import {
  BOOTSTRAP_ALLOWED_DOMAINS,
  BOOTSTRAP_ALLOWED_EMAILS,
  DOMAIN_REJECTION_ERROR_CODE,
  DOMAIN_REJECTION_MESSAGE,
  extractEmailDomain,
  isAllowedEmail,
  isValidDomain,
  isValidEmail,
  normalizeDomain,
  normalizeEmail,
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

  describe('BOOTSTRAP_ALLOWED_EMAILS', () => {
    it('is empty by default — admins use the UI/CLI to seed', () => {
      expect(BOOTSTRAP_ALLOWED_EMAILS).toEqual([])
    })
    it('is a readonly array of lowercase strings (defensive contract)', () => {
      for (const e of BOOTSTRAP_ALLOWED_EMAILS) expect(e).toBe(e.toLowerCase())
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

    // --- Per-email allowlist (third arg). Backward-compatible default [] ---
    it('emails list defaults to [] when omitted (backward-compat)', () => {
      expect(isAllowedEmail('alice@flatout.solutions', ['flatout.solutions'])).toBe(true)
      expect(isAllowedEmail('samuel.asseg@gmail.com', ['flatout.solutions'])).toBe(false)
    })
    it('accepts when email exact-matches an entry in the explicit emails list', () => {
      expect(isAllowedEmail('samuel.asseg@gmail.com', [], ['samuel.asseg@gmail.com'])).toBe(true)
    })
    it('explicit-email match is case-insensitive', () => {
      expect(isAllowedEmail('Samuel.Asseg@Gmail.Com', [], ['samuel.asseg@gmail.com'])).toBe(true)
      expect(isAllowedEmail('samuel.asseg@gmail.com', [], ['SAMUEL.ASSEG@GMAIL.COM'])).toBe(true)
    })
    it('explicit-email mismatch falls through (no domain match) → false', () => {
      expect(isAllowedEmail('not.samuel@gmail.com', [], ['samuel.asseg@gmail.com'])).toBe(false)
    })
    it('domain match still works when emails list is non-empty', () => {
      expect(isAllowedEmail('alice@flatout.solutions', ['flatout.solutions'], ['samuel.asseg@gmail.com'])).toBe(true)
    })
    it('plus-tagged email NOT auto-matched against bare explicit entry (strict)', () => {
      // Explicit allowlist semantics: 'samuel.asseg@gmail.com' allows
      // ONLY that address, not 'samuel.asseg+work@gmail.com'. If admins
      // want plus-tag tolerance, they add the plus-tag form too.
      expect(isAllowedEmail('samuel.asseg+work@gmail.com', [], ['samuel.asseg@gmail.com'])).toBe(false)
    })
    it('whitespace-padded input is rejected with explicit-email list (regression)', () => {
      expect(isAllowedEmail(' samuel.asseg@gmail.com ', [], ['samuel.asseg@gmail.com'])).toBe(false)
    })
    it('rejects empty/null/undefined email even when explicit list is set', () => {
      expect(isAllowedEmail(null, [], ['x@y.com'])).toBe(false)
      expect(isAllowedEmail(undefined, [], ['x@y.com'])).toBe(false)
      expect(isAllowedEmail('', [], ['x@y.com'])).toBe(false)
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

  describe('extractEmailDomain', () => {
    it('extracts the canonical domain', () => {
      expect(extractEmailDomain('alice@flatout.solutions')).toBe('flatout.solutions')
    })
    it('lowercases the domain', () => {
      expect(extractEmailDomain('Alice@FlatOut.Solutions')).toBe('flatout.solutions')
    })
    it('uses lastIndexOf for multi-@ emails (regression for self-removal bug)', () => {
      // If we had used `split('@')[1]`, this would resolve to 'chunk' and
      // the self-removal guard would slip past — letting the caller delete
      // the domain that owns their email. lastIndexOf binds to the same
      // boundary `isAllowedEmail` uses (the SUFFIX match).
      expect(extractEmailDomain('multi@chunk@flatout.solutions')).toBe('flatout.solutions')
    })
    it('returns null when there is no @', () => {
      expect(extractEmailDomain('no-at-sign')).toBeNull()
    })
    it('returns null for empty/null/undefined input', () => {
      expect(extractEmailDomain('')).toBeNull()
      expect(extractEmailDomain(null)).toBeNull()
      expect(extractEmailDomain(undefined)).toBeNull()
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

  describe('normalizeEmail', () => {
    it('lowercases', () => {
      expect(normalizeEmail('Alice@FlatOut.Solutions')).toBe('alice@flatout.solutions')
    })
    it('trims', () => {
      expect(normalizeEmail('  alice@acme.com  ')).toBe('alice@acme.com')
    })
    it('combo', () => {
      expect(normalizeEmail('  ALICE@ACME.com  ')).toBe('alice@acme.com')
    })
    it('preserves the local part casing-folded form (no plus-tag mangling)', () => {
      // We do NOT strip plus-tags. samuel.asseg+work@gmail.com is a
      // distinct address from samuel.asseg@gmail.com and stays distinct
      // after normalization.
      expect(normalizeEmail('Samuel.Asseg+Work@Gmail.com')).toBe('samuel.asseg+work@gmail.com')
    })
  })

  describe('isValidEmail', () => {
    it('accepts canonical', () => {
      expect(isValidEmail('alice@flatout.solutions')).toBe(true)
      expect(isValidEmail('a.b+tag@example.co.uk')).toBe(true)
      expect(isValidEmail('samuel.asseg@gmail.com')).toBe(true)
    })
    it('rejects empty / null-ish input', () => {
      expect(isValidEmail('')).toBe(false)
    })
    it('rejects no @', () => {
      expect(isValidEmail('aliceflatout.solutions')).toBe(false)
    })
    it('rejects multiple @', () => {
      expect(isValidEmail('a@b@flatout.solutions')).toBe(false)
    })
    it('rejects empty local part', () => {
      expect(isValidEmail('@flatout.solutions')).toBe(false)
    })
    it('rejects empty domain part', () => {
      expect(isValidEmail('alice@')).toBe(false)
    })
    it('rejects invalid domain', () => {
      expect(isValidEmail('alice@no-dot')).toBe(false)
      expect(isValidEmail('alice@a..b')).toBe(false)
    })
    it('rejects whitespace anywhere', () => {
      expect(isValidEmail('al ice@acme.com')).toBe(false)
      expect(isValidEmail('alice@acme com')).toBe(false)
      expect(isValidEmail(' alice@acme.com')).toBe(false)
      expect(isValidEmail('alice@acme.com ')).toBe(false)
    })
  })
})
