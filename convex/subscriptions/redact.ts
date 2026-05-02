/**
 * Strip Anthropic OAuth-token-shaped substrings from log messages
 * before they are persisted to refreshLog.error or any other audit field.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §6.
 *
 * Token shape (per claude-swap and observed Anthropic OAuth output):
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
