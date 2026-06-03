/**
 * Revoke a single Clerk OAuth grant/refresh token so a machine can't renew.
 * PENDING CVLT-3 Phase 0: the exact Clerk Backend API endpoint + auth are not
 * yet confirmed (OAuth app not registered). Implemented as an explicit
 * not-yet-wired error so revokeDevice surfaces it rather than silently
 * skipping the token revoke. Wire the real BAPI call here once Phase 0 lands.
 */
export async function revokeOAuthGrant(grantRef: string): Promise<void> {
  throw new Error(`revokeOAuthGrant not yet implemented (CVLT-3 Phase 0 pending) for grant ${grantRef}`)
}
