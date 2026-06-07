# In-Place Token Refresh (Neutered-RT + Hook) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a shared Claude subscription survive long, concurrent, multi-machine use by having the Convex vault be the _sole_ OAuth refresher and feeding each machine a fresh access token (with a neutered refresh token) via a `UserPromptSubmit` hook that runs `cvault pull`.

**Architecture:** The vault holds the real refresh token and proactively rotates it server-side on a cron (single writer → no rotation storm). Clients never hold a usable refresh token: `cvault switch`/`sync`/`pull` write the access token with the refresh token replaced by a sentinel. A `UserPromptSubmit` hook (installed into `~/.claude/settings.json` at `cvault login`) runs `cvault pull` before each prompt to keep the keychain fresh; `claude` re-reads the keychain when its cached token expires (empirically confirmed — see Risk note). No proxy, no daemon.

**Tech Stack:** Convex (actions/crons/scheduler), TypeScript, Bun (CLI), citty, Vitest.

---

## Risk / assumption note (read first, not a code task)

This design depends on a behavior that is **undocumented and version-dependent**: a running `claude` re-reads the keychain when its cached access token expires. This was confirmed empirically with `scripts/keychain-reread-test.ts` (control fails with `401 Invalid bearer token`; writing a fresh token mid-session makes the same session's prompt succeed) and the `UserPromptSubmit` hook was confirmed to run _before_ the request fires. If a future `claude` version regresses, fall back to the request-proxy approach (`scripts/proxy-spike.ts`, already validated as a spike). Add a smoke check of the re-read behavior to release testing.

## File structure

**Convex (control plane):**

- Modify `convex/subscriptions/actions.ts` — add `neuterRefreshToken` option + `NEUTERED_REFRESH_TOKEN` constant + `neuterBlobRefreshToken` helper to `pullForSwitch`.
- Modify `convex/subscriptions/crons.ts` — add `refreshExpiringSubs` internalAction (fans `refreshOAuthToken` over active subs; the inner action no-ops unless near expiry).
- Modify `convex/crons.ts` — register the refresh cron.
- Create `convex/subscriptions/pullForSwitch.test.ts` — neuter behavior.
- Create `convex/subscriptions/refreshExpiringSubs.test.ts` — cron fan-out.

**CLI (delivery):**

- Create `cli/src/native/claudeSettings.ts` — read/merge/write `~/.claude/settings.json` + add/remove the `UserPromptSubmit` hook (pure fns + locked IO).
- Create `cli/src/commands/pull.ts` — `cvault pull`: skip-if-fresh, else pull a neutered token and write it. Best-effort (never blocks the prompt).
- Create `cli/src/commands/logout.ts` — `cvault logout`: remove the hook + delete the session.
- Modify `cli/src/commands/switch.ts` — pass `neuterRefreshToken: true`.
- Modify `cli/src/commands/sync.ts` — pass `neuterRefreshToken: true`.
- Modify `cli/src/commands/login.ts` — install the hook after writing the session.
- Modify `cli/src/index.ts` — register `pull` and `logout`.
- Create `cli/tests/native/claudeSettings.test.ts`, `cli/tests/commands/pull.test.ts`, `cli/tests/commands/logout.test.ts`.

Convex tests run with `yarn test` (root). CLI tests run with `cd cli && yarn test`.

---

## Task 1: Neuter the refresh token in `pullForSwitch`

**Files:**

- Modify: `convex/subscriptions/actions.ts` (the `pullForSwitch` action, ~lines 26–157)
- Test: `convex/subscriptions/pullForSwitch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `convex/subscriptions/pullForSwitch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import { NEUTERED_REFRESH_TOKEN } from './actions'
import { __setAnthropicFetch } from './anthropic'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

const BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-REAL-AAAAAAAAAAAAAAAAAAAA',
    refreshToken: 'sk-ant-ort01-REAL-BBBBBBBBBBBBBBBBBBBB',
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
  config: { oauthAccount: { emailAddress: 'a@b.com' } },
})

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 13).toString('base64')
  __setAnthropicFetch((() => Promise.resolve(new Response('rl', { status: 429 }))) as typeof fetch)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  __setAnthropicFetch(undefined)
  if (ORIGINAL_KEY === undefined) delete process.env.VAULT_AES_KEY
  else process.env.VAULT_AES_KEY = ORIGINAL_KEY
})

describe('pullForSwitch neuterRefreshToken', () => {
  it('replaces the refresh token with the sentinel when neuterRefreshToken is true', async () => {
    const t = vault()
    await seedUser(t)
    await t.action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'a@b.com',
      plaintextBlob: BLOB,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
      clerkSessionId: TEST_IDENTITY.sid,
    })
    const pulled = await t.action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'a@b.com',
      neuterRefreshToken: true,
      clerkSessionId: TEST_IDENTITY.sid,
    })
    const blob = JSON.parse(pulled.plaintextBlob) as { claudeAiOauth: { refreshToken: string; accessToken: string } }
    expect(blob.claudeAiOauth.refreshToken).toBe(NEUTERED_REFRESH_TOKEN)
    expect(blob.claudeAiOauth.accessToken).toBe('sk-ant-oat01-REAL-AAAAAAAAAAAAAAAAAAAA')
  })

  it('returns the real refresh token when the flag is absent (back-compat)', async () => {
    const t = vault()
    await seedUser(t)
    await t.action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'a@b.com',
      plaintextBlob: BLOB,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
      clerkSessionId: TEST_IDENTITY.sid,
    })
    const pulled = await t.action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'a@b.com',
      clerkSessionId: TEST_IDENTITY.sid,
    })
    const blob = JSON.parse(pulled.plaintextBlob) as { claudeAiOauth: { refreshToken: string } }
    expect(blob.claudeAiOauth.refreshToken).toBe('sk-ant-ort01-REAL-BBBBBBBBBBBBBBBBBBBB')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn vitest run convex/subscriptions/pullForSwitch.test.ts`
Expected: FAIL — `NEUTERED_REFRESH_TOKEN` is not exported from `./actions`.

- [ ] **Step 3: Implement the neuter option**

In `convex/subscriptions/actions.ts`, add near the top of the file (after the imports / before `pullForSwitch`):

```ts
/** Sentinel written in place of a usable refresh token so clients can never
 *  rotate the shared grant — only the vault refreshes (single writer). */
export const NEUTERED_REFRESH_TOKEN = 'cvault-neutered-no-refresh'

function neuterBlobRefreshToken(plaintext: string): string {
  const blob = JSON.parse(plaintext) as { claudeAiOauth?: { refreshToken?: string } }
  if (blob.claudeAiOauth) blob.claudeAiOauth.refreshToken = NEUTERED_REFRESH_TOKEN
  return JSON.stringify(blob)
}
```

In the `pullForSwitch` `args`, add the option:

```ts
    neuterRefreshToken: v.optional(v.boolean()),
```

Update the handler signature destructure to include it:

```ts
    { slotOrEmail, machineLabel, clerkSessionId: callerArgSid, neuterRefreshToken },
```

Replace the final decrypt + return block (currently lines ~149–155) with:

```ts
const decrypted = decrypt(fresh.ciphertext, fresh.nonce, fresh.keyVersion)
const plaintext = neuterRefreshToken === true ? neuterBlobRefreshToken(decrypted) : decrypted
const contentHash = await sha256Hex(plaintext)
return {
  email: fresh.email,
  slot: fresh.slot,
  plaintextBlob: plaintext,
  contentHash,
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `yarn vitest run convex/subscriptions/pullForSwitch.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add convex/subscriptions/actions.ts convex/subscriptions/pullForSwitch.test.ts
git commit -m "feat(convex): add neuterRefreshToken option to pullForSwitch"
```

---

## Task 2: Proactive refresh cron (vault as sole refresher)

**Files:**

- Modify: `convex/subscriptions/crons.ts`
- Modify: `convex/crons.ts`
- Test: `convex/subscriptions/refreshExpiringSubs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `convex/subscriptions/refreshExpiringSubs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'
import { __setAnthropicFetch } from './anthropic'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 13).toString('base64')
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  __setAnthropicFetch(undefined)
  if (ORIGINAL_KEY === undefined) delete process.env.VAULT_AES_KEY
  else process.env.VAULT_AES_KEY = ORIGINAL_KEY
})

describe('refreshExpiringSubs', () => {
  it('refreshes a sub that is within the proactive window', async () => {
    const t = vault()
    await seedUser(t)
    // Token already near expiry → the inner refreshOAuthToken should rotate it.
    const nearExpiry = Date.now() + 60 * 1000
    await t.action(api.subscriptions.actions.upsertFromPlaintext, {
      email: 'a@b.com',
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-OLD',
          refreshToken: 'sk-ant-ort01-OLD',
          expiresAt: nearExpiry,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
        config: { oauthAccount: { emailAddress: 'a@b.com' } },
      }),
      expiresAt: nearExpiry,
      subscriptionType: 'max',
      rateLimitTier: 'tier1',
      clerkSessionId: TEST_IDENTITY.sid,
    })

    // Anthropic returns a fresh token set.
    __setAnthropicFetch((() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ access_token: 'sk-ant-oat01-NEW', refresh_token: 'sk-ant-ort01-NEW', expires_in: 28800 }),
          {
            status: 200,
          }
        )
      )) as typeof fetch)

    await t.action(internal.subscriptions.crons.refreshExpiringSubs, {})

    const pulled = await t.action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'a@b.com',
      clerkSessionId: TEST_IDENTITY.sid,
    })
    const blob = JSON.parse(pulled.plaintextBlob) as { claudeAiOauth: { accessToken: string } }
    expect(blob.claudeAiOauth.accessToken).toBe('sk-ant-oat01-NEW')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn vitest run convex/subscriptions/refreshExpiringSubs.test.ts`
Expected: FAIL — `internal.subscriptions.crons.refreshExpiringSubs` does not exist.

- [ ] **Step 3: Implement the cron action**

In `convex/subscriptions/crons.ts`, add below `pollUsage`:

```ts
/**
 * Proactively refresh every active sub's OAuth token. The inner
 * `refreshOAuthToken` action no-ops unless the sub is within
 * `REFRESH_PROACTIVE_MS` of expiry (and uses the refresh lease), so fanning
 * it over all subs is safe and cheap. This makes the VAULT the sole
 * refresher — clients (which carry a neutered refresh token) never rotate.
 */
export const refreshExpiringSubs = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const active = await ctx.runQuery(internal.subscriptions.internalReads.listAllActiveSubIds, {})
    const results = await Promise.allSettled(
      active.map((row) =>
        ctx.runAction(internal.subscriptions.actions.refreshOAuthToken, {
          subId: row.subId,
          triggeredBy: 'onUse',
        })
      )
    )
    for (const [idx, r] of results.entries()) {
      if (r.status === 'rejected') {
        const subId = active[idx]?.subId ?? 'unknown'
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
        console.error(`[cvault] refreshExpiringSubs: sub ${String(subId)} threw unhandled: ${reason}`)
      }
    }
    return null
  },
})
```

(The imports `internalAction`, `v`, and `internal` are already present at the top of `crons.ts` from `pollUsage`.)

- [ ] **Step 4: Register the cron**

In `convex/crons.ts`, add below the `pollUsage` line:

```ts
crons.interval(
  'refresh expiring subscription tokens',
  { minutes: 2 },
  internal.subscriptions.crons.refreshExpiringSubs,
  {}
)
```

- [ ] **Step 5: Run the test and make sure it passes**

Run: `yarn vitest run convex/subscriptions/refreshExpiringSubs.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/subscriptions/crons.ts convex/crons.ts convex/subscriptions/refreshExpiringSubs.test.ts
git commit -m "feat(convex): proactive refresh cron so the vault is the sole token refresher"
```

---

## Task 3: `claudeSettings.ts` — settings.json hook management

**Files:**

- Create: `cli/src/native/claudeSettings.ts`
- Test: `cli/tests/native/claudeSettings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/tests/native/claudeSettings.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { addUserPromptSubmitHook, removeUserPromptSubmitHook } from '../../src/native/claudeSettings'

const CMD = '/opt/homebrew/bin/cvault pull'

describe('addUserPromptSubmitHook', () => {
  it('adds a synchronous command hook, preserving other keys', () => {
    const out = addUserPromptSubmitHook({ theme: 'dark', hooks: { Stop: [{ matcher: '.*', hooks: [] }] } }, CMD)
    expect(out.theme).toBe('dark')
    expect(out.hooks?.Stop).toHaveLength(1)
    expect(out.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]).toEqual({ type: 'command', command: CMD })
  })

  it('is idempotent — does not add the same command twice', () => {
    const once = addUserPromptSubmitHook({}, CMD)
    const twice = addUserPromptSubmitHook(once, CMD)
    expect(twice.hooks?.UserPromptSubmit).toHaveLength(1)
  })
})

describe('removeUserPromptSubmitHook', () => {
  it('removes only our command, leaving others intact', () => {
    const withTwo = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'other' }] },
          { hooks: [{ type: 'command', command: CMD }] },
        ],
      },
    }
    const out = removeUserPromptSubmitHook(withTwo, CMD)
    expect(out.hooks?.UserPromptSubmit).toHaveLength(1)
    expect(out.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe('other')
  })

  it('drops the UserPromptSubmit key entirely when no groups remain', () => {
    const out = removeUserPromptSubmitHook(
      { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: CMD }] }] } },
      CMD
    )
    expect(out.hooks?.UserPromptSubmit).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd cli && bunx --bun vitest run tests/native/claudeSettings.test.ts`
Expected: FAIL — module `../../src/native/claudeSettings` not found.

- [ ] **Step 3: Implement the module**

Create `cli/src/native/claudeSettings.ts`:

```ts
/**
 * Read/merge/write `~/.claude/settings.json` to install or remove the
 * cvault `UserPromptSubmit` hook (`cvault pull`). Claude Code reads this
 * file on every invocation and runs the hook synchronously before the
 * prompt is processed, so `cvault pull` keeps the keychain fresh and a
 * running `claude` re-reads it on token expiry.
 *
 * Writes go through the shared `~/.claude` lock so we never race Claude
 * Code's own writes to that directory.
 */
import { existsSync, readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { withFileLock } from './lock'
import { getClaudeConfigHome } from './paths'

export interface HookCommand {
  type: string
  command: string
  async?: boolean
}
export interface HookGroup {
  matcher?: string
  hooks: HookCommand[]
}
export interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>
  [k: string]: unknown
}

export function settingsPath(): string {
  return join(getClaudeConfigHome(), 'settings.json')
}

export function readSettings(): ClaudeSettings {
  const path = settingsPath()
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as ClaudeSettings
}

/** Pure: append a synchronous UserPromptSubmit hook unless it already exists. */
export function addUserPromptSubmitHook(settings: ClaudeSettings, command: string): ClaudeSettings {
  const hooks = settings.hooks ?? {}
  const existing = hooks.UserPromptSubmit ?? []
  const alreadyPresent = existing.some((g) => g.hooks.some((h) => h.command === command))
  if (alreadyPresent) return settings
  const group: HookGroup = { hooks: [{ type: 'command', command }] }
  return { ...settings, hooks: { ...hooks, UserPromptSubmit: [...existing, group] } }
}

/** Pure: remove our command; drop the UserPromptSubmit key if it becomes empty. */
export function removeUserPromptSubmitHook(settings: ClaudeSettings, command: string): ClaudeSettings {
  const hooks = settings.hooks
  if (!hooks?.UserPromptSubmit) return settings
  const kept = hooks.UserPromptSubmit.map((g) => ({
    ...g,
    hooks: g.hooks.filter((h) => h.command !== command),
  })).filter((g) => g.hooks.length > 0)
  const nextHooks: Record<string, HookGroup[]> = { ...hooks }
  if (kept.length > 0) nextHooks.UserPromptSubmit = kept
  else delete nextHooks.UserPromptSubmit
  return { ...settings, hooks: nextHooks }
}

function writeSettings(settings: ClaudeSettings): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n')
}

export async function installPullHook(command: string): Promise<void> {
  await withFileLock(() => {
    writeSettings(addUserPromptSubmitHook(readSettings(), command))
  })
}

export async function uninstallPullHook(command: string): Promise<void> {
  await withFileLock(() => {
    writeSettings(removeUserPromptSubmitHook(readSettings(), command))
  })
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd cli && bunx --bun vitest run tests/native/claudeSettings.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/src/native/claudeSettings.ts cli/tests/native/claudeSettings.test.ts
git commit -m "feat(cli): settings.json UserPromptSubmit hook install/remove helpers"
```

---

## Task 4: `cvault pull` command

**Files:**

- Create: `cli/src/commands/pull.ts`
- Test: `cli/tests/commands/pull.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/tests/commands/pull.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runPull } from '../../src/commands/pull'
import { makeVaultClient } from '../../src/convex/vaultClient'
import { getActiveAccount, importEnvelope } from '../../src/credentials'
import { readCredentials } from '../../src/native/credentialStore'

vi.mock('../../src/convex/vaultClient')
vi.mock('../../src/native/credentialStore')
vi.mock('../../src/credentials')

afterEach(() => vi.clearAllMocks())

function fakeClient(action: ReturnType<typeof vi.fn>) {
  return { action, withMeta: (a: Record<string, unknown>) => a } as unknown as Awaited<
    ReturnType<typeof makeVaultClient>
  >
}

describe('runPull', () => {
  it('skips the network when the local token is still fresh', async () => {
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'a@b.com' })
    vi.mocked(readCredentials).mockReturnValue(
      JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60 * 60 * 1000 } })
    )
    const action = vi.fn()
    vi.mocked(makeVaultClient).mockResolvedValue(fakeClient(action))

    await runPull()

    expect(action).not.toHaveBeenCalled()
    expect(importEnvelope).not.toHaveBeenCalled()
  })

  it('pulls a NEUTERED token and writes it when the local token is near expiry', async () => {
    vi.mocked(getActiveAccount).mockReturnValue({ email: 'a@b.com' })
    vi.mocked(readCredentials).mockReturnValue(JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60 * 1000 } }))
    const action = vi.fn().mockResolvedValue({
      email: 'a@b.com',
      slot: 1,
      plaintextBlob: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'NEW',
          refreshToken: 'cvault-neutered-no-refresh',
          expiresAt: 0,
          scopes: [],
          subscriptionType: 'max',
        },
      }),
      contentHash: 'h',
    })
    vi.mocked(makeVaultClient).mockResolvedValue(fakeClient(action))

    await runPull()

    expect(action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ slotOrEmail: 'a@b.com', neuterRefreshToken: true })
    )
    expect(importEnvelope).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when there is no active account', async () => {
    vi.mocked(getActiveAccount).mockReturnValue(null)
    await runPull()
    expect(importEnvelope).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd cli && bunx --bun vitest run tests/commands/pull.test.ts`
Expected: FAIL — `../../src/commands/pull` not found.

- [ ] **Step 3: Implement the command**

Create `cli/src/commands/pull.ts`:

```ts
/**
 * `cvault pull` — keep the active subscription's local token fresh.
 *
 * Invoked by the `UserPromptSubmit` hook before every `claude` prompt, so it
 * MUST be cheap and MUST NOT block the prompt:
 *   - skip entirely (no network) when the local token is comfortably fresh;
 *   - otherwise pull a NEUTERED token (dead refresh token) from the vault and
 *     write it to the keychain so a running `claude` re-reads it on expiry;
 *   - swallow all errors (exit 0) so a vault/network hiccup never blocks work.
 */
import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { makeVaultClient } from '../convex/vaultClient'
import { getActiveAccount, importEnvelope } from '../credentials'
import { buildSingleAccountEnvelope } from '../envelope'
import { readCredentials } from '../native/credentialStore'

/** Refresh when the local token has less than this much life left. */
const FRESH_WINDOW_MS = 10 * 60 * 1000

function localExpiresAt(): number | undefined {
  let raw: string | null
  try {
    raw = readCredentials()
  } catch {
    return undefined
  }
  if (raw === null) return undefined
  try {
    const blob = JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: unknown } }
    const exp = blob.claudeAiOauth?.expiresAt
    return typeof exp === 'number' ? exp : undefined
  } catch {
    return undefined
  }
}

export async function runPull(): Promise<void> {
  let active
  try {
    active = getActiveAccount()
  } catch {
    return // keychain locked / unreadable — don't block the prompt
  }
  if (active === null) return

  const exp = localExpiresAt()
  if (exp !== undefined && exp > Date.now() + FRESH_WINDOW_MS) return // still fresh — no network

  const client = await makeVaultClient()
  const pull = await client.action(
    api.subscriptions.actions.pullForSwitch,
    client.withMeta({ slotOrEmail: active.email, neuterRefreshToken: true })
  )
  await importEnvelope(buildSingleAccountEnvelope(pull), true)
}

export const pullCommand = defineCommand({
  meta: {
    name: 'pull',
    description: 'Refresh the active subscription token from the vault (used by the claude hook).',
  },
  async run() {
    try {
      await runPull()
    } catch (err) {
      // Best-effort: never block the prompt. Log to stderr for diagnostics.
      console.error('cvault pull:', err instanceof Error ? err.message : String(err))
    }
  },
})
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd cli && bunx --bun vitest run tests/commands/pull.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/pull.ts cli/tests/commands/pull.test.ts
git commit -m "feat(cli): add cvault pull (skip-if-fresh, neutered, best-effort)"
```

---

## Task 5: Neuter the refresh token on `switch` and `sync`

**Files:**

- Modify: `cli/src/commands/switch.ts:77-80`
- Modify: `cli/src/commands/sync.ts:42`
- Test: `cli/tests/commands/switch.test.ts` (extend), `cli/tests/commands/sync.test.ts` (extend)

- [ ] **Step 1: Write the failing assertion (switch)**

In `cli/tests/commands/switch.test.ts`, add a test that the action is called with `neuterRefreshToken: true`. Find the existing test that mocks the `pullForSwitch` action call and add:

```ts
it('requests a neutered refresh token from the vault', async () => {
  // (reuse the file's existing setup that mocks makeVaultClient + a successful pull)
  await runSwitch({ slotOrEmail: 'a@b.com' })
  expect(actionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ neuterRefreshToken: true }))
})
```

(Adapt `actionMock`/`runSwitch` to the names already used in that test file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd cli && bunx --bun vitest run tests/commands/switch.test.ts`
Expected: FAIL — current call passes only `{ slotOrEmail }`.

- [ ] **Step 3: Implement (switch)**

In `cli/src/commands/switch.ts`, change the `pullForSwitch` call:

```ts
pull = await client.action(
  api.subscriptions.actions.pullForSwitch,
  client.withMeta({ slotOrEmail: opts.slotOrEmail, neuterRefreshToken: true })
)
```

- [ ] **Step 4: Implement (sync)**

In `cli/src/commands/sync.ts`, change `syncOneUnlocked`'s call:

```ts
const pull = await client.action(
  api.subscriptions.actions.pullForSwitch,
  client.withMeta({ slotOrEmail: sub.email, neuterRefreshToken: true })
)
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `cd cli && bunx --bun vitest run tests/commands/switch.test.ts tests/commands/sync.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/switch.ts cli/src/commands/sync.ts cli/tests/commands/switch.test.ts cli/tests/commands/sync.test.ts
git commit -m "feat(cli): switch/sync write a neutered refresh token (clients never rotate)"
```

---

## Task 6: Install the hook at `login`, add `cvault logout`

**Files:**

- Modify: `cli/src/commands/login.ts:134-137`
- Create: `cli/src/commands/logout.ts`
- Test: `cli/tests/commands/logout.test.ts`, extend `cli/tests/commands/login.test.ts`

- [ ] **Step 1: Add the hook-command helper + install at login**

In `cli/src/commands/login.ts`, add an import:

```ts
import { installPullHook } from '../native/claudeSettings'
```

Add a helper near the top:

```ts
/** The command the UserPromptSubmit hook runs. `process.execPath` is the
 *  cvault binary itself when running the compiled CLI. */
export function pullHookCommand(): string {
  return `${process.execPath} pull`
}
```

After `await writeSession(sessionWithLabel)` (line ~136), add:

```ts
// Install the UserPromptSubmit hook so every `claude` prompt keeps the
// keychain fresh. Best-effort: a settings.json write failure must not fail
// an otherwise-successful login.
try {
  await installPullHook(pullHookCommand())
} catch (err) {
  console.warn('Login succeeded but installing the claude hook failed:', err instanceof Error ? err.message : err)
}
```

- [ ] **Step 2: Write the failing test (logout)**

Create `cli/tests/commands/logout.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deleteSession } from '../../src/auth/session'
import { runLogout } from '../../src/commands/logout'
import { uninstallPullHook } from '../../src/native/claudeSettings'

vi.mock('../../src/native/claudeSettings')
vi.mock('../../src/auth/session')

afterEach(() => vi.clearAllMocks())

describe('runLogout', () => {
  it('removes the hook and deletes the session', async () => {
    vi.mocked(uninstallPullHook).mockResolvedValue()
    vi.mocked(deleteSession).mockResolvedValue()
    await runLogout()
    expect(uninstallPullHook).toHaveBeenCalledTimes(1)
    expect(deleteSession).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd cli && bunx --bun vitest run tests/commands/logout.test.ts`
Expected: FAIL — `../../src/commands/logout` and `deleteSession` do not exist.

- [ ] **Step 4: Add `deleteSession` to the session module**

In `cli/src/auth/session.ts`, add (near `writeSession`):

```ts
import { rm } from 'node:fs/promises'

/** Remove the persisted session file. Idempotent (missing file is fine). */
export async function deleteSession(): Promise<void> {
  await rm(sessionPath(), { force: true })
}
```

(Use the file's existing path helper; if it is named differently than `sessionPath`, call that instead.)

- [ ] **Step 5: Implement the logout command**

Create `cli/src/commands/logout.ts`:

```ts
/**
 * `cvault logout` — remove the claude `UserPromptSubmit` hook and delete the
 * persisted session. Inverse of `cvault login`.
 */
import { defineCommand } from 'citty'

import { deleteSession } from '../auth/session'
import { uninstallPullHook } from '../native/claudeSettings'
import { pullHookCommand } from './login'

export async function runLogout(): Promise<void> {
  await uninstallPullHook(pullHookCommand())
  await deleteSession()
  console.log('Signed out: removed the claude hook and cleared the local session.')
}

export const logoutCommand = defineCommand({
  meta: { name: 'logout', description: 'Remove the claude hook and clear the local cvault session.' },
  async run() {
    await runLogout()
  },
})
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `cd cli && bunx --bun vitest run tests/commands/logout.test.ts tests/commands/login.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cli/src/commands/login.ts cli/src/commands/logout.ts cli/src/auth/session.ts cli/tests/commands/logout.test.ts cli/tests/commands/login.test.ts
git commit -m "feat(cli): install the claude pull-hook at login, add cvault logout"
```

---

## Task 7: Register `pull` and `logout` in the CLI

**Files:**

- Modify: `cli/src/index.ts:25-58`

- [ ] **Step 1: Add imports**

In `cli/src/index.ts`, add to the command imports:

```ts
import { logoutCommand } from './commands/logout'
import { pullCommand } from './commands/pull'
```

- [ ] **Step 2: Register the subcommands**

In the `subCommands` object, add:

```ts
    pull: pullCommand,
    logout: logoutCommand,
```

- [ ] **Step 3: Verify the CLI wires up**

Run: `cd cli && node src/index.ts --help`
Expected: the help output lists `pull` and `logout`.

- [ ] **Step 4: Run the full CLI + Convex test suites**

Run: `cd cli && yarn test` then (repo root) `yarn test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src/index.ts
git commit -m "feat(cli): register pull and logout subcommands"
```

---

## Manual end-to-end verification (after Task 7)

1. Deploy Convex (`npx convex deploy` to the dev deployment) so the new cron + `pullForSwitch` arg are live.
2. `cvault login` → confirm `~/.claude/settings.json` now has a `UserPromptSubmit` hook running `cvault pull`.
3. `cvault switch <email>` → confirm the keychain token's `refreshToken` is `cvault-neutered-no-refresh` (`security find-generic-password -s "Claude Code-credentials" -w | python3 -m json.tool`).
4. Start an interactive `claude`, work past the access-token TTL (or use `scripts/keychain-reread-test.ts set-broken` to force near-expiry) and confirm the session keeps working — the hook + re-read refresh it in place.
5. `cvault logout` → confirm the hook is gone and `~/.vault/session.json` is removed.

## Self-review checklist (completed during authoring)

- **Spec coverage:** sole-refresher cron (Task 2) ✓; neutered vend (Task 1) ✓; clients never hold a real RT — pull/switch/sync all neuter (Tasks 4–5) ✓; automatic via settings.json hook (Tasks 3, 6) ✓; logout teardown (Task 6) ✓; registration (Task 7) ✓.
- **Type consistency:** `NEUTERED_REFRESH_TOKEN` (`'cvault-neutered-no-refresh'`) is defined in Task 1 and referenced verbatim in Tasks 4/5 tests + manual step 3. `pullForSwitch` arg `neuterRefreshToken: boolean` is consistent across Tasks 1, 4, 5. `pullHookCommand()` defined in Task 6 (login.ts) and imported by logout.ts.
- **Placeholders:** none — every code step contains full source. Task 5's test step says to adapt to the existing file's mock names (the only non-verbatim instruction, unavoidable when extending an existing test).

```

```
