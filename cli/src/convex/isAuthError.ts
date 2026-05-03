/**
 * Predicate: does this error look like a Convex auth failure?
 *
 * `ConvexHttpClient` throws plain Errors with messages of the form
 * `"<status> <code>: <message>"` on transport-level failures, plus
 * `ConvexError` for application errors (which never fire on 401 — those
 * are transport-level). Our authenticated* wrappers throw plain
 * `Error('Not authenticated')` when the identity is missing.
 *
 * Spec: docs/research/ts-bun-cli-tooling.md §4.4.
 */
export function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message
  return (
    msg.includes('401') ||
    /unauthenticated/i.test(msg) ||
    /not authenticated/i.test(msg) ||
    // Convex returns these for expired / malformed / signature-fail JWTs.
    // We must trigger a refresh on every variant — otherwise the CLI
    // surfaces a raw `InvalidAuthHeader` to the user the moment the cached
    // 60-second convex JWT lapses.
    /invalidauthheader/i.test(msg) ||
    /invalidauthtoken/i.test(msg) ||
    /could not parse jwt/i.test(msg)
  )
}
