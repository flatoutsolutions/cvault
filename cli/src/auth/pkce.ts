import { createHash, randomBytes } from 'node:crypto'

export function base64UrlEncode(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** RFC 7636 code_verifier: 32 random bytes → 43-char base64url string. */
export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32))
}

/** RFC 7636 S256 challenge: base64url(sha256(verifier)). */
export function codeChallengeS256(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest())
}
