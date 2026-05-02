/**
 * Strip Anthropic OAuth-token-shaped substrings from log messages before
 * we print them or write them anywhere on disk.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §6 + §10.
 *
 * Token shape (matches `convex/subscriptions/redact.ts` so the regex is
 * single-source across the codebase):
 *   sk-ant-{type}{digits}-{base64url-ish chars, length >= 20}
 *
 * Concrete examples we've seen:
 *   sk-ant-oat01-...   (access token)
 *   sk-ant-ort01-...   (refresh token)
 */
const TOKEN_RE = /sk-ant-[a-z]+\d+-[A-Za-z0-9_-]{20,}/g
const REPLACEMENT = '<redacted>'

export function redactTokens(message: string): string {
  if (!message) return message
  return message.replace(TOKEN_RE, REPLACEMENT)
}
