/**
 * Pure formatter for the top-level CLI catch.
 *
 * The Convex HTTP client deserializes server-side `ConvexError({code,
 * message})` payloads back into `ConvexError` instances on the client side
 * (see node_modules/convex/dist/esm/browser/http_client.js → `forwardErrorData`).
 * The `data` property holds whatever the server passed to
 * `new ConvexError(data)`. We use that — never `err.message`, which on the
 * client is the verbose "[Request ID: ...] Server Error\nUncaught
 * ConvexError: {...}" blob that's useless to end users.
 *
 * The contract: known CLI error classes → formatted string, everything
 * else → `null` (caller falls through to the existing generic display
 * path so non-handled behavior stays unchanged per the bug-fix spec's
 * definition of done).
 *
 * Currently dispatched here:
 *   - `ConvexError`                 — server-thrown structured error.
 *   - `ConvexEndpointNotFoundError` — client-thrown 404 from the OAuth refresh call
 *     when the CLI is pointing at a Convex deployment without the cvault
 *     HTTP routes. Routed through the same dispatch so every CLI command
 *     (login + every retry-path command) renders identically; previously
 *     only `cli/src/commands/login.ts` had a bespoke handler and non-login
 *     commands fell through to the generic top-level catch's `error: ...`
 *     line — inconsistent rendering across the surface.
 */
import { ConvexError } from 'convex/values'

import { ConvexEndpointNotFoundError } from '../auth/clerkFapi'

/**
 * Format an unknown thrown value into a single user-facing line.
 *
 * Returns `null` when the value isn't a class this formatter knows about —
 * the caller is expected to fall back to its existing display logic in
 * that case.
 */
export function formatCliError(err: unknown): string | null {
  if (err instanceof ConvexEndpointNotFoundError) {
    // The class's constructor already builds an actionable, multi-clause
    // message (URL + foreign `.env.local` hint + reinstall hint). Surface
    // it verbatim under the same `ERROR:` prefix the ConvexError branch
    // uses, so all dispatched CLI errors render identically.
    return `ERROR: ${err.message}`
  }

  if (!(err instanceof ConvexError)) return null

  const data: unknown = err.data

  if (typeof data === 'string') {
    return `ERROR: ${data}`
  }

  if (isCodeMessageObject(data)) {
    return `ERROR: ${data.message} (${data.code})`
  }

  return `ERROR: ${JSON.stringify(data)}`
}

/**
 * Narrow `unknown` to the structured `{code: string, message: string}`
 * shape. Both fields must be strings — a non-string `code` would render
 * confusingly via raw template-string coercion, so we reject it and let
 * the caller fall through to the JSON-stringify branch.
 */
function isCodeMessageObject(value: unknown): value is { code: string; message: string } {
  if (typeof value !== 'object' || value === null) return false
  if (!('code' in value) || !('message' in value)) return false
  const v = value as { code: unknown; message: unknown }
  return typeof v.code === 'string' && typeof v.message === 'string'
}
