/**
 * Round-trip tests for `buildSingleAccountEnvelope`.
 *
 * Pinned because `claude-swap --import` rejects envelopes whose
 * `credentials` or `config` fields are not JSON objects ("must be JSON
 * objects"). The legacy CLI build uploaded only `claudeAiOauth` in the
 * plaintext blob, so a fresh `cvault switch` after upgrade must still
 * produce a valid envelope by defaulting `config` to `{}`.
 */
import { describe, expect, it } from 'vitest'

import { buildSingleAccountEnvelope } from '../src/envelope'

describe('buildSingleAccountEnvelope', () => {
  it('round-trips full metadata when present (post-fix uploads)', () => {
    const pull = {
      email: 'user@example.com',
      slot: 2,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-AAA',
          refreshToken: 'sk-ant-ort01-BBB',
          expiresAt: 1_900_000_000_000,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
        config: { oauthAccount: { display_name: 'Sam' } },
        uuid: '11111111-1111-1111-1111-111111111111',
        organizationUuid: '22222222-2222-2222-2222-222222222222',
        organizationName: 'Acme',
      }),
    }

    const env = buildSingleAccountEnvelope(pull)
    expect(env.activeAccountNumber).toBe(2)
    expect(env.accounts).toHaveLength(1)
    const acc = env.accounts[0]!
    expect(acc.email).toBe('user@example.com')
    expect(acc.uuid).toBe('11111111-1111-1111-1111-111111111111')
    expect(acc.organizationUuid).toBe('22222222-2222-2222-2222-222222222222')
    expect(acc.organizationName).toBe('Acme')
    expect(acc.config).toEqual({ oauthAccount: { display_name: 'Sam' } })
    expect(acc.credentials.claudeAiOauth.accessToken).toBe('sk-ant-oat01-AAA')
  })

  it('defaults `config` to `{}` for legacy blobs that only carry claudeAiOauth', () => {
    const pull = {
      email: 'old@example.com',
      slot: 1,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: 0,
          scopes: [],
          subscriptionType: 'max',
        },
      }),
    }

    const env = buildSingleAccountEnvelope(pull)
    const acc = env.accounts[0]!
    // Critical invariant: claude-swap rejects missing/non-object `config`.
    expect(acc.config).toEqual({})
    // Org fields stay omitted when not present in the blob.
    expect(acc.organizationUuid).toBeUndefined()
    expect(acc.organizationName).toBeUndefined()
    // UUID falls back to the all-zero placeholder.
    expect(acc.uuid).toBe('00000000-0000-0000-0000-000000000000')
  })
})
