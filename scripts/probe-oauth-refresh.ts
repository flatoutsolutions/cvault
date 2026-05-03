#!/usr/bin/env bun
/**
 * Probe Anthropic OAuth refresh behavior — does the server rotate
 * refresh_token on each refresh, or reuse it (RFC 6749 default)?
 *
 * Reads ~/.claude/.credentials.json (or macOS Keychain on darwin),
 * performs ONE refresh, immediately writes the new token set back so
 * the user's local Claude Code session keeps working regardless of
 * whether rotation happened.
 *
 * Run multiple times across an hour and across days to characterize
 * rotation frequency for cvault's design decisions.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

interface OAuthBlob {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes?: string[]
  subscriptionType?: string
  rateLimitTier?: string
}

interface CredentialsFile {
  claudeAiOauth: OAuthBlob
}

function readDarwinKeychain(): { source: 'keychain' | 'file'; data: CredentialsFile } {
  const account = userInfo().username
  try {
    const stdout = execFileSync('security', ['find-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
    })
    const raw = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
    return { source: 'keychain', data: JSON.parse(raw) as CredentialsFile }
  } catch {
    const fallback = join(homedir(), '.claude', '.credentials.json')
    if (!existsSync(fallback)) {
      throw new Error(
        `No Claude credentials found in Keychain (service "${KEYCHAIN_SERVICE}", account "${account}") or at ${fallback}`
      )
    }
    return { source: 'file', data: JSON.parse(readFileSync(fallback, 'utf8')) as CredentialsFile }
  }
}

function writeDarwinKeychain(data: CredentialsFile, source: 'keychain' | 'file'): void {
  if (source === 'keychain') {
    const account = userInfo().username
    const blob = JSON.stringify(data)
    execFileSync('security', ['add-generic-password', '-U', '-a', account, '-s', KEYCHAIN_SERVICE, '-w', blob])
  } else {
    const fallback = join(homedir(), '.claude', '.credentials.json')
    writeFileSync(fallback, JSON.stringify(data, null, 2), { mode: 0o600 })
  }
}

async function main(): Promise<void> {
  const { source, data } = readDarwinKeychain()
  const oauth = data.claudeAiOauth
  const oldRT = oauth.refreshToken

  console.log(`[probe] source=${source} expiresAt=${new Date(oauth.expiresAt).toISOString()}`)
  console.log(`[probe] oldRT prefix=${oldRT.slice(0, 24)}...`)

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'cvault-probe/0.1.0' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: oldRT,
      client_id: CLIENT_ID,
    }),
  })
  const body = (await resp.json()) as Record<string, unknown>

  if (resp.status !== 200) {
    console.error('[probe] refresh failed', resp.status, body)
    process.exit(1)
  }

  const newAT = body.access_token as string
  const respRT = body.refresh_token as string | undefined
  const newRT = respRT ?? oldRT
  const expiresIn = body.expires_in as number

  data.claudeAiOauth = {
    ...oauth,
    accessToken: newAT,
    refreshToken: newRT,
    expiresAt: Date.now() + expiresIn * 1000,
  }
  writeDarwinKeychain(data, source)

  const result = {
    timestamp: new Date().toISOString(),
    rotated: newRT !== oldRT,
    responseHadRefreshTokenField: 'refresh_token' in body,
    responseKeys: Object.keys(body),
    expiresIn,
    newATPrefix: `${newAT.slice(0, 24)}...`,
    newRTPrefix: `${newRT.slice(0, 24)}...`,
    source,
  }
  console.log(JSON.stringify(result, null, 2))
}

await main()
