/**
 * Verified envelope shape (single-account).
 *
 * Source: research brief python-cli-tooling.md §3 — extracted directly
 * from `claude-swap`'s `transfer.py`. cvault now produces this shape
 * natively (no claude-swap subprocess), but the wire format is unchanged
 * because Convex storage and the on-disk envelope layout are pinned.
 */
import type { ClaudeSwapEnvelope } from '../../../src/credentials'

export function singleAccountEnvelope(
  overrides: Partial<ClaudeSwapEnvelope['accounts'][number]> = {}
): ClaudeSwapEnvelope {
  return {
    version: 1,
    exportedAt: '2026-05-02T16:00:00Z',
    exportedFrom: 'macos',
    swapVersion: '0.10.1',
    encrypted: false,
    activeAccountNumber: 1,
    accounts: [
      {
        number: 1,
        email: 'user@example.com',
        uuid: '11111111-1111-1111-1111-111111111111',
        organizationUuid: '22222222-2222-2222-2222-222222222222',
        organizationName: 'Test Org',
        added: '2026-04-01T00:00:00Z',
        credentials: {
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA',
            refreshToken: 'sk-ant-ort01-BBBBBBBBBBBBBBBBBBBB',
            expiresAt: 1735689600000,
            scopes: ['user:inference', 'user:profile'],
            subscriptionType: 'max',
          },
        },
        config: { oauthAccount: { display_name: 'Stefan' } },
        ...overrides,
      },
    ],
  }
}
