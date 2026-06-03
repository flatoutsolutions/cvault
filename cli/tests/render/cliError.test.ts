/**
 * Spec: bug-fix sweep §"CLI error display for ConvexError" + PR #25
 * follow-up §"Consistent error rendering across all CLI commands".
 *
 * `formatCliError` is the pure formatter that the top-level CLI catch uses
 * to turn a thrown value into a single user-facing line. The contract is
 * intentionally narrow:
 *
 *   - ConvexError with `{code, message}` data → "ERROR: <message> (<code>)"
 *   - ConvexError with string data            → "ERROR: <data>"
 *   - ConvexError with any other shape        → "ERROR: <JSON>"
 *   - ConvexEndpointNotFoundError              → "ERROR: <message>"
 *   - non-ConvexError                         → null  (caller falls through
 *                                                     to the generic display)
 *
 * Returning `null` for non-ConvexError keeps the existing display path for
 * regular Errors, plain strings, and `undefined` untouched — the bug-fix
 * spec explicitly requires that the existing behavior for non-ConvexError
 * be preserved.
 *
 * The `ConvexEndpointNotFoundError` branch was added so every CLI command
 * (login + every retry-path command) renders the wrong-deployment hijack
 * the same way. Previously only `cli/src/commands/login.ts` had a bespoke
 * `Error: ${err.message}` print + exit; non-login commands fell through to
 * the generic top-level catch's `error: ${msg}` line, which was an
 * inconsistent rendering across the surface.
 */
import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'

import { ConvexEndpointNotFoundError } from '../../src/convex/errors'
import { formatCliError } from '../../src/render/cliError'

describe('formatCliError', () => {
  describe('ConvexError', () => {
    it('formats {code, message} object data as "ERROR: <message> (<code>)"', () => {
      const err = new ConvexError({ code: 'NOT_FOUND', message: 'No subscription at slot 1' })
      expect(formatCliError(err)).toBe('ERROR: No subscription at slot 1 (NOT_FOUND)')
    })

    it('formats string data as "ERROR: <data>"', () => {
      const err = new ConvexError('Something went wrong')
      expect(formatCliError(err)).toBe('ERROR: Something went wrong')
    })

    it('falls back to JSON for object data missing `code`', () => {
      const err = new ConvexError({ message: 'no code here' })
      expect(formatCliError(err)).toBe(`ERROR: ${JSON.stringify({ message: 'no code here' })}`)
    })

    it('falls back to JSON for object data missing `message`', () => {
      const err = new ConvexError({ code: 'NO_MSG' })
      expect(formatCliError(err)).toBe(`ERROR: ${JSON.stringify({ code: 'NO_MSG' })}`)
    })

    it('falls back to JSON when `code` is present but not a string', () => {
      // The narrowing must require BOTH fields to be strings before applying
      // the structured format — a non-string code would render confusingly
      // as "ERROR: <message> ([object Object])" if we just String()-coerced.
      const err = new ConvexError({ code: 42, message: 'numeric code' })
      expect(formatCliError(err)).toBe(`ERROR: ${JSON.stringify({ code: 42, message: 'numeric code' })}`)
    })

    it('falls back to JSON for number data', () => {
      const err = new ConvexError(404)
      expect(formatCliError(err)).toBe('ERROR: 404')
    })

    it('falls back to JSON for null data', () => {
      const err = new ConvexError(null)
      expect(formatCliError(err)).toBe('ERROR: null')
    })

    it('falls back to JSON for array data', () => {
      const err = new ConvexError(['a', 'b'])
      expect(formatCliError(err)).toBe(`ERROR: ${JSON.stringify(['a', 'b'])}`)
    })
  })

  describe('ConvexEndpointNotFoundError', () => {
    // The wrong-deployment hijack class is not a `ConvexError` — it's a
    // plain `Error` subclass thrown client-side from `mintConvexJwt`. It
    // routes through the same `formatCliError` dispatch so login + every
    // non-login command render the same actionable line + exit 1
    // (instead of login printing one form and the retry path falling
    // through to the generic `error: <msg>` printer).
    it('formats ConvexEndpointNotFoundError as "ERROR: <message>"', () => {
      const err = new ConvexEndpointNotFoundError(
        'https://hijacker.convex.site/api/cli/mint-token',
        'No matching routes found'
      )
      const formatted = formatCliError(err)
      expect(formatted).not.toBeNull()
      // The formatter returns the message verbatim (already actionable —
      // includes the URL + .env.local pointer + reinstall hint), prefixed
      // with the same "ERROR:" tag the ConvexError branch uses.
      expect(formatted).toContain('ERROR:')
      // The message body itself must be present so the user sees the URL
      // they tried + the .env.local hint.
      expect(formatted).toContain('hijacker.convex.site')
      expect(formatted).toMatch(/\.env\.local/i)
    })

    it('does not append a `(<code>)` suffix — the class is a plain Error, not a ConvexError', () => {
      // Defensive: `ConvexEndpointNotFoundError` is not a `ConvexError` so
      // the structured `(NOT_FOUND)`-style suffix from the ConvexError
      // branch must NOT appear (no `code` field on the class).
      const err = new ConvexEndpointNotFoundError(
        'https://x.convex.site/api/cli/mint-token',
        'No matching routes found'
      )
      const formatted = formatCliError(err) ?? ''
      // Trailing parenthesised suffix would look like "(SOMETHING)" at end
      // of the string. Make sure we aren't accidentally rendering one.
      expect(formatted).not.toMatch(/\(\w+\)\s*$/)
    })
  })

  describe('non-ConvexError fall-through', () => {
    it('returns null for a regular Error', () => {
      expect(formatCliError(new Error('plain error'))).toBeNull()
    })

    it('returns null for a plain string throw', () => {
      expect(formatCliError('boom')).toBeNull()
    })

    it('returns null for undefined', () => {
      expect(formatCliError(undefined)).toBeNull()
    })

    it('returns null for null', () => {
      expect(formatCliError(null)).toBeNull()
    })

    it('returns null for an arbitrary object', () => {
      expect(formatCliError({ random: 'object' })).toBeNull()
    })
  })
})
