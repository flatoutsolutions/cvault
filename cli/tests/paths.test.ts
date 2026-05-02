/**
 * Spec: §6, §7 — `~/.vault/` 0700 dir + 0600 atomic-write secrets.
 *
 * The path module owns directory + permission discipline. We test against
 * a temp `HOME` per test so we never touch the developer's real `~/.vault/`.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensureVaultDir,
  lastHashPath,
  readSecret,
  vaultDir,
  vaultFile,
  writeSecret,
} from '../src/paths'

let tempHome: string
let originalHome: string | undefined

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cvault-paths-test-'))
  originalHome = process.env.HOME
  vi.stubEnv('HOME', tempHome)
})

afterEach(() => {
  if (originalHome !== undefined) {
    vi.stubEnv('HOME', originalHome)
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('vaultDir / vaultFile', () => {
  it('returns paths under the current HOME', () => {
    expect(vaultDir()).toBe(join(tempHome, '.vault'))
    expect(vaultFile('session.json')).toBe(join(tempHome, '.vault', 'session.json'))
  })
})

describe('ensureVaultDir', () => {
  it('creates ~/.vault/ with mode 0700 when missing', async () => {
    await ensureVaultDir()
    const stats = statSync(join(tempHome, '.vault'))
    expect(stats.isDirectory()).toBe(true)
    // Mask the type bits — we only care about the perm bits.
    expect(stats.mode & 0o777).toBe(0o700)
  })

  it('tightens mode to 0700 when the directory already exists with looser perms', async () => {
    const dir = join(tempHome, '.vault')
    // Create with overly-loose 0755
    const { mkdirSync, chmodSync } = await import('node:fs')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755) // be explicit even when umask masked it
    await ensureVaultDir()
    const stats = statSync(dir)
    expect(stats.mode & 0o777).toBe(0o700)
  })
})

describe('writeSecret + readSecret', () => {
  it('writes a file with mode 0600 atomically', async () => {
    const target = vaultFile('session.json')
    await writeSecret(target, '{"hello":"world"}')
    const stats = statSync(target)
    expect(stats.mode & 0o777).toBe(0o600)
    expect(await readSecret(target)).toBe('{"hello":"world"}')
  })

  it('readSecret returns null when the file does not exist', async () => {
    const target = vaultFile('nope.json')
    expect(await readSecret(target)).toBeNull()
  })

  it('writeSecret overwrites prior content', async () => {
    const target = vaultFile('cycle.json')
    await writeSecret(target, 'first')
    await writeSecret(target, 'second')
    expect(await readSecret(target)).toBe('second')
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('writeSecret cleans up the .tmp file when the rename succeeds', async () => {
    const target = vaultFile('clean.json')
    await writeSecret(target, 'data')
    const tmpExists = (await import('node:fs')).existsSync(`${target}.tmp`)
    expect(tmpExists).toBe(false)
  })
})

describe('readSecret with loose perms', () => {
  it('throws when the secret has world/group bits set', async () => {
    const target = vaultFile('loose.json')
    // Bypass writeSecret so we can deliberately leak perms.
    const { mkdirSync, chmodSync } = await import('node:fs')
    mkdirSync(join(tempHome, '.vault'), { recursive: true })
    writeFileSync(target, 'leak')
    chmodSync(target, 0o644)
    await expect(readSecret(target)).rejects.toThrow(/perm/i)
  })
})

describe('lastHashPath', () => {
  it('returns ~/.vault/last-hash-{email}.txt for safe emails', () => {
    expect(lastHashPath('user@example.com')).toBe(
      join(tempHome, '.vault', 'last-hash-user@example.com.txt')
    )
  })

  it('strips path traversal characters from the email', () => {
    expect(lastHashPath('../etc/passwd')).toBe(
      join(tempHome, '.vault', 'last-hash-__etc_passwd.txt')
    )
    expect(lastHashPath('a/b@c')).toBe(join(tempHome, '.vault', 'last-hash-a_b@c.txt'))
  })
})
