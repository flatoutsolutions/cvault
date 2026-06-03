/**
 * Client-side CLI error classes thrown when communicating with the Convex
 * deployment. Kept separate from `clerkFapi` (deleted in Task 19) so
 * `cliError.ts` and other callers can import them from a stable location.
 */

/**
 * Thrown when the Convex HTTP router returns a 404 with body containing
 * `No matching routes found` — the standard Convex "no route registered"
 * response. This signals that the CLI is pointing at a Convex deployment
 * that does not have the cvault HTTP routes (e.g. because a foreign
 * `.env.local` in the user's CWD overrode the baked config — see
 * `cli/src/config.ts` priority docs).
 *
 * Previously lived in `cli/src/auth/clerkFapi.ts` (deleted Task 19) and was
 * thrown by `mintConvexJwt`. The OAuth refresh path (`refreshAccessToken` in
 * `oauthPkce.ts`) goes directly to Clerk's token endpoint, not to a Convex
 * route, so this class is currently only thrown by `vaultClient.ts` if a
 * non-auth Convex HTTP call returns 404 + the unrouted marker body — or
 * re-thrown for parity when detected elsewhere. Relocating here rather than
 * deleting so `cliError.ts` can still format it consistently.
 *
 * Note (deferred): detecting wrong-deployment from the OAuth refresh path is
 * out of scope for Task 19. If needed in future, `vaultClient.ts` should
 * detect the 404 marker on non-auth Convex calls and throw this class.
 */
export class ConvexEndpointNotFoundError extends Error {
  override readonly name = 'ConvexEndpointNotFoundError'
  /** The full Convex URL the CLI tried to hit. */
  readonly url: string
  /** Truncated 404 response body. */
  readonly body: string
  constructor(url: string, body: string) {
    super(
      `cvault is pointing at a Convex deployment that does not have the cvault HTTP routes registered ` +
        `(URL: ${url}). This usually means a foreign .env.local in your current directory is overriding ` +
        `the baked CLI config — check VITE_CONVEX_URL / CLERK_FRONTEND_API_URL in your CWD. ` +
        `If those env vars are correct, your installed binary may be older than the deployed routes — ` +
        `reinstall the latest cvault (e.g. \`brew upgrade cvault\` if installed via Homebrew, or re-download ` +
        `from https://github.com/flatoutsolutions/cvault/releases). (body: ${body.slice(0, 200)})`
    )
    this.url = url
    this.body = body
  }
}
