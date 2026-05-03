import { describe, expect, it } from 'vitest'

// Pin USER_AGENT to the *exact* CLI version, not just a semver-shaped string,
// so a future bump to cli/package.json never silently drifts from the UA we
// ship on every Anthropic OAuth call. The original PR #7 fix (correcting the
// repo URL) substituted a hardcoded `0.1.5` literal, which would have rotted
// on the next bump — see anthropic.ts for the matching json-import fix.
import pkg from '../../cli/package.json' with { type: 'json' }
import { USER_AGENT } from './anthropic'

describe('USER_AGENT', () => {
  it('points at the canonical flatoutsolutions/cvault repo', () => {
    expect(USER_AGENT).toContain('flatoutsolutions/cvault')
  })

  it('does not reference the old saadings/cvault repo', () => {
    expect(USER_AGENT).not.toContain('saadings/cvault')
  })

  it('uses the exact version from cli/package.json', () => {
    expect(USER_AGENT).toBe(`cvault/${pkg.version} (+https://github.com/flatoutsolutions/cvault)`)
  })
})
