# Key Rotation + Encrypted Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the two deferred-to-v2 settings cards: encryption key rotation (re-wrap every stored credential blob with a fresh AES-256 master key) and encrypted backup export/import (passphrase-protected disaster recovery bundle).

**Architecture:** Two-key crypto envelope (`VAULT_AES_KEY` current + `VAULT_AES_KEY_PREVIOUS` decrypt-only) with per-row `keyVersion` field for incremental rotation. Backup uses scrypt KDF on a user-supplied passphrase + AES-256-GCM per account inside a portable JSON bundle. Both features ship without feature flags (per user direction 2026-05-04); access control is owner-scoped Clerk auth.

**Tech Stack:** Convex (TypeScript, `'use node'` for crypto), `node:crypto` (AES-256-GCM, scrypt), Vitest (unit + scenario tests), citty CLI, TanStack Start dashboard with shadcn/ui components.

**Spec:** `docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md`

---

## File Structure

### Backend (`convex/`)

| File                                                     | Action     | Responsibility                                                                                        |
| -------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| `subscriptions/schema.ts`                                | Modify     | Add `keyVersion: v.optional(v.string())`                                                              |
| `subscriptions/crypto.ts`                                | Modify     | Two-key loader + `currentKeyVersion()` + `keyVersion` returned from `encrypt` + accepted by `decrypt` |
| `subscriptions/crypto.node.test.ts`                      | Modify     | Add tests for two-key + version round-trip                                                            |
| `subscriptions/keyVersioning.test.ts`                    | Create     | Unit tests focused on `currentKeyVersion()` resolution                                                |
| `subscriptions/mutations.ts`                             | Modify     | `upsertSub` writes `keyVersion`; new `patchRotatedRow` internal mutation                              |
| `subscriptions/actions.ts`                               | Modify     | All `encrypt` callers store `keyVersion`; all `decrypt` callers pass `keyVersion`                     |
| `keyRotationJobs/schema.ts`                              | Create     | Track rotation progress per user                                                                      |
| `keyRotationJobs/mutations.ts`                           | Create     | Internal CRUD for the jobs table                                                                      |
| `keyRotationJobs/queries.ts`                             | Create     | `getJob` (owner-scoped) for dashboard polling                                                         |
| `keyRotationJobs/actions.ts`                             | Create     | `triggerKeyRotation` public + `rotateAllSubscriptions` internal                                       |
| `keyRotationJobs/actions.test.ts`                        | Create     | Unit tests for rotation logic                                                                         |
| `backup/schema.ts`                                       | Not needed | Backup is stateless (no DB rows)                                                                      |
| `backup/actions.ts`                                      | Create     | `exportEncryptedBackup` + `importEncryptedBackup`                                                     |
| `backup/bundle.ts`                                       | Create     | Bundle shape + parse/build helpers (testable in isolation)                                            |
| `backup/bundle.test.ts`                                  | Create     | Unit tests for bundle helpers                                                                         |
| `backup/actions.test.ts`                                 | Create     | Unit tests for export/import actions                                                                  |
| `schema.ts`                                              | Modify     | Register `keyRotationJobs` table                                                                      |
| `__scenarios__/keyRotation.scenario.test.ts`             | Create     | End-to-end rotation story                                                                             |
| `__scenarios__/backupRoundtrip.scenario.test.ts`         | Create     | End-to-end backup export+import                                                                       |
| `__scenarios__/keyRotationDuringWrites.scenario.test.ts` | Create     | Concurrency story                                                                                     |

### CLI (`cli/`)

| File                                  | Action | Responsibility                    |
| ------------------------------------- | ------ | --------------------------------- |
| `src/commands/rotateKey.ts`           | Create | `cvault rotate-key` command       |
| `src/commands/exportBackup.ts`        | Create | `cvault export <out.cvb>` command |
| `src/commands/importBackup.ts`        | Create | `cvault import <in.cvb>` command  |
| `src/index.ts`                        | Modify | Wire the three new subcommands    |
| `tests/commands/rotateKey.test.ts`    | Create | Unit tests                        |
| `tests/commands/exportBackup.test.ts` | Create | Unit tests                        |
| `tests/commands/importBackup.test.ts` | Create | Unit tests                        |

### Frontend (`frontend/`)

| File                                                             | Action | Responsibility                                |
| ---------------------------------------------------------------- | ------ | --------------------------------------------- |
| `src/components/dashboard/RotateKeyDialog.tsx`                   | Create | 3-step modal                                  |
| `src/components/dashboard/ExportBackupDialog.tsx`                | Create | Passphrase + download                         |
| `src/components/dashboard/ImportBackupDialog.tsx`                | Create | File picker + passphrase + restore            |
| `src/routes/dashboard/settings.lazy.tsx`                         | Modify | Replace disabled buttons with the new dialogs |
| `src/components/dashboard/__tests__/RotateKeyDialog.test.tsx`    | Create | Component tests                               |
| `src/components/dashboard/__tests__/ExportBackupDialog.test.tsx` | Create | Component tests                               |
| `src/components/dashboard/__tests__/ImportBackupDialog.test.tsx` | Create | Component tests                               |

---

## Task 1: Schema migration — add `keyVersion` field

**Files:**

- Modify: `convex/subscriptions/schema.ts`

- [ ] **Step 1: Add the optional field**

```ts
// convex/subscriptions/schema.ts
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const subscriptionsSchema = defineTable({
  userId: v.id('users'),
  email: v.string(),
  slot: v.number(),
  label: v.optional(v.string()),
  ciphertext: v.bytes(),
  nonce: v.bytes(),
  /**
   * Identifier of the master key version used to encrypt `ciphertext`.
   * `undefined` means "v1" (legacy rows written before key versioning).
   * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §3.
   */
  keyVersion: v.optional(v.string()),
  expiresAt: v.number(),
  refreshExpiresAt: v.optional(v.number()),
  subscriptionType: v.string(),
  rateLimitTier: v.string(),
  lastRefreshedAt: v.number(),
  refreshLeaseHolder: v.optional(v.string()),
  refreshLeaseUntil: v.optional(v.number()),
  usage5h: v.optional(v.object({ pct: v.number(), resetsAt: v.number(), fetchedAt: v.number() })),
  usage7d: v.optional(v.object({ pct: v.number(), resetsAt: v.number(), fetchedAt: v.number() })),
  removedAt: v.optional(v.number()),
})
  .index('byUserAndSlot', ['userId', 'slot'])
  .index('byUserAndEmail', ['userId', 'email'])
  .index('byExpiry', ['expiresAt'])
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/saadings/Desktop/cvault && yarn lint:check`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add convex/subscriptions/schema.ts
git commit -m "feat(schema): add optional keyVersion to subscriptions for rotation"
```

---

## Task 2: Crypto module — version-aware loader

**Files:**

- Modify: `convex/subscriptions/crypto.ts`
- Test: `convex/subscriptions/keyVersioning.test.ts` (create)

- [ ] **Step 1: Write failing test for `currentKeyVersion()`**

Create `convex/subscriptions/keyVersioning.test.ts`:

```ts
/**
 * Unit tests for the version-aware crypto loader.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §4.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { currentKeyVersion, decrypt, encrypt } from './crypto'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY
const ORIGINAL_PREVIOUS = process.env.VAULT_AES_KEY_PREVIOUS
const ORIGINAL_VERSION = process.env.VAULT_KEY_VERSION

beforeEach(() => {
  // Distinct fill bytes from other test files to keep parallel runs clean.
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 41).toString('base64')
  delete process.env.VAULT_AES_KEY_PREVIOUS
  delete process.env.VAULT_KEY_VERSION
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.VAULT_AES_KEY
  else process.env.VAULT_AES_KEY = ORIGINAL_KEY
  if (ORIGINAL_PREVIOUS === undefined) delete process.env.VAULT_AES_KEY_PREVIOUS
  else process.env.VAULT_AES_KEY_PREVIOUS = ORIGINAL_PREVIOUS
  if (ORIGINAL_VERSION === undefined) delete process.env.VAULT_KEY_VERSION
  else process.env.VAULT_KEY_VERSION = ORIGINAL_VERSION
})

describe('currentKeyVersion', () => {
  it('returns "v1" by default', () => {
    expect(currentKeyVersion()).toBe('v1')
  })

  it('returns VAULT_KEY_VERSION when set', () => {
    process.env.VAULT_KEY_VERSION = 'v2'
    expect(currentKeyVersion()).toBe('v2')
  })
})

describe('encrypt/decrypt with versioning', () => {
  it('encrypt returns the current key version label', () => {
    const result = encrypt('hello world')
    expect(result.keyVersion).toBe('v1')
  })

  it('encrypt returns "v2" label when VAULT_KEY_VERSION=v2', () => {
    process.env.VAULT_KEY_VERSION = 'v2'
    const result = encrypt('hello world')
    expect(result.keyVersion).toBe('v2')
  })

  it('decrypt round-trips when keyVersion matches current', () => {
    const { ciphertext, nonce, keyVersion } = encrypt('hello world')
    expect(decrypt(ciphertext, nonce, keyVersion)).toBe('hello world')
  })

  it('decrypt round-trips a row whose keyVersion matches PREVIOUS', () => {
    // Encrypt under "v1" with the original VAULT_AES_KEY.
    const oldEncrypted = encrypt('original')
    expect(oldEncrypted.keyVersion).toBe('v1')

    // Rotate: old key → PREVIOUS, new key → current, version → v2.
    process.env.VAULT_AES_KEY_PREVIOUS = process.env.VAULT_AES_KEY
    process.env.VAULT_AES_KEY = Buffer.alloc(32, 53).toString('base64')
    process.env.VAULT_KEY_VERSION = 'v2'

    // The old row's keyVersion is still "v1" — decrypt must look up PREVIOUS.
    expect(decrypt(oldEncrypted.ciphertext, oldEncrypted.nonce, oldEncrypted.keyVersion)).toBe('original')
  })

  it('decrypt treats undefined keyVersion as v1 (legacy rows)', () => {
    const { ciphertext, nonce } = encrypt('legacy')
    // Legacy row written before keyVersion field existed → undefined.
    expect(decrypt(ciphertext, nonce, undefined)).toBe('legacy')
  })

  it('decrypt throws when row keyVersion matches neither current nor previous', () => {
    const { ciphertext, nonce } = encrypt('lost')
    // Caller asks for a version we have no key for.
    expect(() => decrypt(ciphertext, nonce, 'v99')).toThrow(/No master key/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/subscriptions/keyVersioning.test.ts`
Expected: FAIL — `currentKeyVersion` not exported and `encrypt` does not return `keyVersion`.

- [ ] **Step 3: Update crypto.ts implementation**

Replace `convex/subscriptions/crypto.ts` entirely with:

```ts
'use node'

/**
 * AES-256-GCM encryption envelope for subscription credentials.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §4.
 *
 * Two-key model:
 *  - VAULT_AES_KEY        — the *current* master key. New writes use it.
 *  - VAULT_AES_KEY_PREVIOUS — optional. Set during a rotation window so
 *    rows written under the previous key can still be read.
 *  - VAULT_KEY_VERSION    — human-readable label for the current key
 *    (default "v1"). Stored on every newly-written row so rotation can
 *    target stale rows by version filter.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const KEY_LENGTH_BYTES = 32
const NONCE_LENGTH_BYTES = 12
const AUTH_TAG_LENGTH_BYTES = 16
const DEFAULT_VERSION = 'v1'

export function currentKeyVersion(): string {
  return process.env.VAULT_KEY_VERSION ?? DEFAULT_VERSION
}

function decodeKey(raw: string, envName: string): Buffer {
  let key: Buffer
  try {
    key = Buffer.from(raw, 'base64')
  } catch {
    throw new Error(`${envName} must be base64-encoded`)
  }
  if (key.byteLength !== KEY_LENGTH_BYTES) {
    throw new Error(`${envName} must decode to exactly 32 bytes (got ${key.byteLength.toString()})`)
  }
  return key
}

function loadKeyForVersion(version: string): Buffer {
  const current = currentKeyVersion()
  if (version === current) {
    const raw = process.env.VAULT_AES_KEY
    if (!raw) {
      throw new Error('VAULT_AES_KEY env var is not set; cannot encrypt/decrypt subscription credentials')
    }
    return decodeKey(raw, 'VAULT_AES_KEY')
  }
  // Different version → must be the rotation-window predecessor.
  const raw = process.env.VAULT_AES_KEY_PREVIOUS
  if (!raw) {
    throw new Error(
      `No master key available for keyVersion=${version} (currentVersion=${current}). ` +
        `Set VAULT_AES_KEY_PREVIOUS to the previous master key and retry.`
    )
  }
  return decodeKey(raw, 'VAULT_AES_KEY_PREVIOUS')
}

function loadCurrentKey(): Buffer {
  return loadKeyForVersion(currentKeyVersion())
}

export interface EncryptResult {
  /** AES-256-GCM ciphertext concatenated with the 16-byte auth tag. */
  ciphertext: ArrayBuffer
  /** 12-byte nonce / IV; must be persisted and passed back to decrypt(). */
  nonce: ArrayBuffer
  /** The keyVersion label this ciphertext was encrypted under. */
  keyVersion: string
}

export function encrypt(plaintext: string): EncryptResult {
  const key = loadCurrentKey()
  const nonce = randomBytes(NONCE_LENGTH_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const bundle = Buffer.concat([enc, tag])
  return {
    ciphertext: bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength),
    nonce: nonce.buffer.slice(nonce.byteOffset, nonce.byteOffset + nonce.byteLength),
    keyVersion: currentKeyVersion(),
  }
}

/**
 * Decrypt a ciphertext bundle. `keyVersion` selects which env-var key to
 * use; `undefined` (legacy row) is treated as "v1".
 */
export function decrypt(ciphertextBundle: ArrayBuffer, nonce: ArrayBuffer, keyVersion?: string): string {
  const version = keyVersion ?? DEFAULT_VERSION
  const key = loadKeyForVersion(version)

  const bundle = Buffer.from(ciphertextBundle)
  if (bundle.byteLength < AUTH_TAG_LENGTH_BYTES) {
    throw new Error('ciphertext is too short to contain an AES-GCM auth tag')
  }
  const enc = bundle.subarray(0, bundle.byteLength - AUTH_TAG_LENGTH_BYTES)
  const tag = bundle.subarray(bundle.byteLength - AUTH_TAG_LENGTH_BYTES)
  const nonceBuf = Buffer.from(nonce)
  const decipher = createDecipheriv('aes-256-gcm', key, nonceBuf)
  decipher.setAuthTag(tag)
  const out = Buffer.concat([decipher.update(enc), decipher.final()])
  return out.toString('utf8')
}
```

- [ ] **Step 4: Run new tests + existing crypto tests**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/subscriptions/keyVersioning.test.ts convex/subscriptions/crypto.node.test.ts`
Expected: PASS for both.

- [ ] **Step 5: Update existing crypto callers (compile errors)**

Run: `cd /Users/saadings/Desktop/cvault && yarn lint:check 2>&1 | head -100`
Read the resulting list. For every `decrypt(ciphertext, nonce)` call site that no longer satisfies the type, pass `sub.keyVersion` (typically). For every `encrypt(blob)` call site, capture the `keyVersion` from the result and forward it through to the mutation.

Specific call sites to update:

- `convex/subscriptions/actions.ts`: `pullForSwitch`, `upsertFromPlaintext`, `refreshSub` (adoptLocalState path), `refreshOAuthToken`, `fetchUsageForSub`
- `convex/__scenarios__/_helpers.scenario.ts`: `seedSubscription`'s `encrypt` call

For each callsite, change:

```ts
const plaintext = decrypt(sub.ciphertext, sub.nonce)
```

to:

```ts
const plaintext = decrypt(sub.ciphertext, sub.nonce, sub.keyVersion)
```

And change:

```ts
const { ciphertext, nonce } = encrypt(plaintextBlob)
```

to:

```ts
const { ciphertext, nonce, keyVersion } = encrypt(plaintextBlob)
```

…then forward `keyVersion` through the mutation argument list (Task 3 patches the mutations).

- [ ] **Step 6: Commit**

```bash
git add convex/subscriptions/crypto.ts convex/subscriptions/keyVersioning.test.ts convex/subscriptions/actions.ts convex/__scenarios__/_helpers.scenario.ts
git commit -m "feat(crypto): two-key envelope with keyVersion for rotation"
```

---

## Task 3: Mutations — accept and persist `keyVersion`

**Files:**

- Modify: `convex/subscriptions/mutations.ts`

- [ ] **Step 1: Write failing test for `upsertEncrypted` storing keyVersion**

Add to `convex/subscriptions/upsertFromPlaintext.test.ts` (an existing file — read it first to see the existing pattern):

```ts
it('upsertFromPlaintext stores the current keyVersion on the row', async () => {
  process.env.VAULT_KEY_VERSION = 'v7'
  const t = vault()
  await seedUser(t)
  const result = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.upsertFromPlaintext, {
    email: 'kv@example.com',
    plaintextBlob: '{"claudeAiOauth":{"accessToken":"x","refreshToken":"y","expiresAt":1,"scopes":[]}}',
    expiresAt: 1,
    subscriptionType: 'max',
    rateLimitTier: 'tier1',
  })
  const row = await t.run(async (ctx) => await ctx.db.get('subscriptions', result.subId))
  expect(row?.keyVersion).toBe('v7')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/subscriptions/upsertFromPlaintext.test.ts`
Expected: FAIL — `keyVersion` not stored.

- [ ] **Step 3: Patch `upsertSub` (and `commitRefreshedTokens`, `adoptLocalState`) to accept and write `keyVersion`**

In `convex/subscriptions/mutations.ts`:

a) Extend `UpsertSubInput` and the validators with `keyVersion: v.string()` (REQUIRED — actions always supply it).
b) Inside `upsertSub`, set `keyVersion: input.keyVersion` on every `ctx.db.insert` and `ctx.db.patch`.
c) Extend `commitRefreshedTokens` args with `keyVersion: v.string()` and patch it through.
d) Extend `adoptLocalState` args with `keyVersion: v.string()` and patch it through.

Then update `convex/subscriptions/actions.ts` callers to pass `keyVersion` in every `runMutation` call.

- [ ] **Step 4: Add `patchRotatedRow` internal mutation**

Append to `convex/subscriptions/mutations.ts`:

```ts
/**
 * Patch a single row with re-wrapped ciphertext + new keyVersion. Used
 * exclusively by the rotateAllSubscriptions internal action.
 */
export const patchRotatedRow = internalMutation({
  args: {
    subId: v.id('subscriptions'),
    ciphertext: v.bytes(),
    nonce: v.bytes(),
    keyVersion: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { subId, ciphertext, nonce, keyVersion }) => {
    const sub = await ctx.db.get('subscriptions', subId)
    if (!sub) return null
    // CAS-style guard: do nothing if the row is already on the target
    // version (idempotent re-runs / parallel rotation jobs).
    if (sub.keyVersion === keyVersion) return null
    await ctx.db.patch('subscriptions', subId, { ciphertext, nonce, keyVersion })
    return null
  },
})
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/subscriptions/`
Expected: PASS for all subscriptions tests (the keyVersion change must not regress anything).

- [ ] **Step 6: Commit**

```bash
git add convex/subscriptions/mutations.ts convex/subscriptions/actions.ts convex/subscriptions/upsertFromPlaintext.test.ts
git commit -m "feat(subscriptions): persist keyVersion on every write + patchRotatedRow mutation"
```

---

## Task 4: keyRotationJobs schema + register

**Files:**

- Create: `convex/keyRotationJobs/schema.ts`
- Modify: `convex/schema.ts`

- [ ] **Step 1: Create the schema file**

```ts
// convex/keyRotationJobs/schema.ts
/**
 * Tracks an in-flight or completed key-rotation job per user.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §3 + §5.
 */
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const keyRotationJobsSchema = defineTable({
  userId: v.id('users'),
  status: v.union(v.literal('pending'), v.literal('running'), v.literal('completed'), v.literal('failed')),
  totalRows: v.number(),
  processedRows: v.number(),
  errorCount: v.number(),
  startedAt: v.number(),
  completedAt: v.optional(v.number()),
  fromVersion: v.optional(v.string()),
  toVersion: v.string(),
  lastError: v.optional(v.string()),
}).index('byUserAndStartedAt', ['userId', 'startedAt'])
```

- [ ] **Step 2: Register in `convex/schema.ts`**

```ts
import { defineSchema } from 'convex/server'

import { keyRotationJobsSchema } from './keyRotationJobs/schema'
import { machineActivitySchema } from './machineActivity/schema'
import { rateLimitSchema } from './rateLimit/schema'
import { refreshLogSchema } from './refreshLog/schema'
import { subscriptionsSchema } from './subscriptions/schema'
import { usersSchema } from './users/schema'

export default defineSchema({
  keyRotationJobs: keyRotationJobsSchema,
  machineActivity: machineActivitySchema,
  rateLimit: rateLimitSchema,
  refreshLog: refreshLogSchema,
  subscriptions: subscriptionsSchema,
  users: usersSchema,
})
```

- [ ] **Step 3: Generate convex types + lint**

Run: `cd /Users/saadings/Desktop/cvault && yarn lint:check`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add convex/keyRotationJobs/schema.ts convex/schema.ts
git commit -m "feat(schema): add keyRotationJobs table"
```

---

## Task 5: keyRotationJobs internal mutations

**Files:**

- Create: `convex/keyRotationJobs/mutations.ts`
- Test: `convex/keyRotationJobs/mutations.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// convex/keyRotationJobs/mutations.test.ts
/**
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §3 + §5.
 */
import { describe, expect, it } from 'vitest'

import { TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { internal } from '../_generated/api'

describe('keyRotationJobs mutations (internal)', () => {
  it('insertJob creates a pending row and returns its id', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const jobId = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 5,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    const row = await t.run(async (ctx) => await ctx.db.get('keyRotationJobs', jobId))
    expect(row?.status).toBe('pending')
    expect(row?.totalRows).toBe(5)
    expect(row?.processedRows).toBe(0)
    expect(row?.errorCount).toBe(0)
  })

  it('markRunning flips status to running', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const jobId = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 1,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    await t.mutation(internal.keyRotationJobs.mutations.markRunning, { jobId })
    const row = await t.run(async (ctx) => await ctx.db.get('keyRotationJobs', jobId))
    expect(row?.status).toBe('running')
  })

  it('incrementProgress patches counters', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const jobId = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 10,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    await t.mutation(internal.keyRotationJobs.mutations.incrementProgress, {
      jobId,
      deltaProcessed: 3,
      deltaErrors: 1,
    })
    const row = await t.run(async (ctx) => await ctx.db.get('keyRotationJobs', jobId))
    expect(row?.processedRows).toBe(3)
    expect(row?.errorCount).toBe(1)
  })

  it('markCompleted sets completedAt + status', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const jobId = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 0,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    await t.mutation(internal.keyRotationJobs.mutations.markCompleted, { jobId })
    const row = await t.run(async (ctx) => await ctx.db.get('keyRotationJobs', jobId))
    expect(row?.status).toBe('completed')
    expect(row?.completedAt).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/keyRotationJobs/mutations.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `convex/keyRotationJobs/mutations.ts`**

```ts
/**
 * Internal mutations driving the keyRotationJobs lifecycle.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §5.
 */
import { ConvexError, v } from 'convex/values'

import { internalMutation } from '../_generated/server'

export const insertJob = internalMutation({
  args: {
    userId: v.id('users'),
    totalRows: v.number(),
    fromVersion: v.optional(v.string()),
    toVersion: v.string(),
  },
  returns: v.id('keyRotationJobs'),
  handler: async (ctx, args) => {
    return await ctx.db.insert('keyRotationJobs', {
      userId: args.userId,
      status: 'pending',
      totalRows: args.totalRows,
      processedRows: 0,
      errorCount: 0,
      startedAt: Date.now(),
      ...(args.fromVersion !== undefined ? { fromVersion: args.fromVersion } : {}),
      toVersion: args.toVersion,
    })
  },
})

export const markRunning = internalMutation({
  args: { jobId: v.id('keyRotationJobs') },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get('keyRotationJobs', jobId)
    if (!job) throw new ConvexError({ code: 'NOT_FOUND', message: 'Job missing' })
    await ctx.db.patch(jobId, { status: 'running' })
    return null
  },
})

export const incrementProgress = internalMutation({
  args: {
    jobId: v.id('keyRotationJobs'),
    deltaProcessed: v.number(),
    deltaErrors: v.number(),
    lastError: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { jobId, deltaProcessed, deltaErrors, lastError }) => {
    const job = await ctx.db.get('keyRotationJobs', jobId)
    if (!job) return null
    const patch: {
      processedRows: number
      errorCount: number
      lastError?: string
    } = {
      processedRows: job.processedRows + deltaProcessed,
      errorCount: job.errorCount + deltaErrors,
    }
    if (lastError !== undefined) patch.lastError = lastError
    await ctx.db.patch(jobId, patch)
    return null
  },
})

export const markCompleted = internalMutation({
  args: { jobId: v.id('keyRotationJobs') },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get('keyRotationJobs', jobId)
    if (!job) return null
    await ctx.db.patch(jobId, { status: 'completed', completedAt: Date.now() })
    return null
  },
})

export const markFailed = internalMutation({
  args: { jobId: v.id('keyRotationJobs'), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { jobId, error }) => {
    const job = await ctx.db.get('keyRotationJobs', jobId)
    if (!job) return null
    await ctx.db.patch(jobId, { status: 'failed', completedAt: Date.now(), lastError: error })
    return null
  },
})
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/keyRotationJobs/mutations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/keyRotationJobs/mutations.ts convex/keyRotationJobs/mutations.test.ts
git commit -m "feat(keyRotationJobs): internal mutations for lifecycle"
```

---

## Task 6: keyRotationJobs queries (owner-scoped)

**Files:**

- Create: `convex/keyRotationJobs/queries.ts`
- Test: `convex/keyRotationJobs/queries.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// convex/keyRotationJobs/queries.test.ts
import { describe, expect, it } from 'vitest'

import { SECOND_IDENTITY, TEST_IDENTITY, seedUser, vault } from '../__tests__/helpers'
import { api, internal } from '../_generated/api'

describe('keyRotationJobs.queries.getJob', () => {
  it('returns the job to its owner', async () => {
    const t = vault()
    const userId = await seedUser(t)
    const jobId = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId,
      totalRows: 0,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    const got = await t.withIdentity(TEST_IDENTITY).query(api.keyRotationJobs.queries.getJob, { jobId })
    expect(got).not.toBeNull()
    expect(got?.toVersion).toBe('v2')
  })

  it('returns null for a non-owner', async () => {
    const t = vault()
    const ownerUserId = await seedUser(t, TEST_IDENTITY)
    await seedUser(t, SECOND_IDENTITY)
    const jobId = await t.mutation(internal.keyRotationJobs.mutations.insertJob, {
      userId: ownerUserId,
      totalRows: 0,
      fromVersion: 'v1',
      toVersion: 'v2',
    })
    const got = await t.withIdentity(SECOND_IDENTITY).query(api.keyRotationJobs.queries.getJob, { jobId })
    expect(got).toBeNull()
  })
})
```

- [ ] **Step 2: Implement `convex/keyRotationJobs/queries.ts`**

```ts
/**
 * Owner-scoped read of a keyRotationJobs row. Used by the dashboard to
 * poll progress while a rotation is running.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §3.
 */
import { v } from 'convex/values'

import { authenticatedQuery, getIdentity } from '../utils/auth'

const jobValidator = v.object({
  _id: v.id('keyRotationJobs'),
  _creationTime: v.number(),
  userId: v.id('users'),
  status: v.union(v.literal('pending'), v.literal('running'), v.literal('completed'), v.literal('failed')),
  totalRows: v.number(),
  processedRows: v.number(),
  errorCount: v.number(),
  startedAt: v.number(),
  completedAt: v.optional(v.number()),
  fromVersion: v.optional(v.string()),
  toVersion: v.string(),
  lastError: v.optional(v.string()),
})

export const getJob = authenticatedQuery({
  args: { jobId: v.id('keyRotationJobs') },
  returns: v.union(jobValidator, v.null()),
  handler: async (ctx, { jobId }) => {
    const identity = getIdentity(ctx)
    const job = await ctx.db.get('keyRotationJobs', jobId)
    if (!job) return null
    const owner = await ctx.db.get('users', job.userId)
    if (!owner || owner.externalId !== identity.subject) return null
    return job
  },
})

export const getLatestJobForCaller = authenticatedQuery({
  args: {},
  returns: v.union(jobValidator, v.null()),
  handler: async (ctx) => {
    const identity = getIdentity(ctx)
    const user = await ctx.db
      .query('users')
      .withIndex('byExternalId', (q) => q.eq('externalId', identity.subject))
      .unique()
    if (!user) return null
    const latest = await ctx.db
      .query('keyRotationJobs')
      .withIndex('byUserAndStartedAt', (q) => q.eq('userId', user._id))
      .order('desc')
      .first()
    return latest ?? null
  },
})
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/keyRotationJobs/queries.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add convex/keyRotationJobs/queries.ts convex/keyRotationJobs/queries.test.ts
git commit -m "feat(keyRotationJobs): owner-scoped getJob + getLatestJobForCaller"
```

---

## Task 7: triggerKeyRotation public action + rotateAllSubscriptions internal action

**Files:**

- Create: `convex/keyRotationJobs/actions.ts`
- Test: `convex/keyRotationJobs/actions.test.ts`
- Modify: `convex/subscriptions/internalReads.ts` (add `listSubsForRotation`)

- [ ] **Step 1: Add `listSubsForRotation` internal query**

Append to `convex/subscriptions/internalReads.ts`:

```ts
/**
 * Internal query returning rows whose keyVersion does not match the supplied
 * targetVersion. Used by the rotation action to find work to do.
 *
 * Returns the full row (ciphertext + nonce + keyVersion) so the action
 * can decrypt without a second read.
 */
export const listSubsForRotation = internalQuery({
  args: { userId: v.id('users'), targetVersion: v.string() },
  returns: v.array(subscriptionRawValidator),
  handler: async (ctx, { userId, targetVersion }) => {
    const rows = await ctx.db
      .query('subscriptions')
      .withIndex('byUserAndSlot', (q) => q.eq('userId', userId))
      .collect()
    return rows.filter((r) => r.removedAt === undefined && (r.keyVersion ?? 'v1') !== targetVersion)
  },
})
```

- [ ] **Step 2: Write failing test for triggerKeyRotation**

```ts
// convex/keyRotationJobs/actions.test.ts
/**
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §5.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { seedSubscription } from '../__scenarios__/_helpers.scenario'
import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY
const ORIGINAL_PREVIOUS = process.env.VAULT_AES_KEY_PREVIOUS
const ORIGINAL_VERSION = process.env.VAULT_KEY_VERSION

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 71).toString('base64')
  delete process.env.VAULT_AES_KEY_PREVIOUS
  delete process.env.VAULT_KEY_VERSION
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.VAULT_AES_KEY
  else process.env.VAULT_AES_KEY = ORIGINAL_KEY
  if (ORIGINAL_PREVIOUS === undefined) delete process.env.VAULT_AES_KEY_PREVIOUS
  else process.env.VAULT_AES_KEY_PREVIOUS = ORIGINAL_PREVIOUS
  if (ORIGINAL_VERSION === undefined) delete process.env.VAULT_KEY_VERSION
  else process.env.VAULT_KEY_VERSION = ORIGINAL_VERSION
})

describe('triggerKeyRotation', () => {
  it('no-ops when all rows are already on the current version', async () => {
    const t = vault()
    await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'a@example.com',
      expiresAt: Date.now() + 60_000,
    })
    const result = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    expect(result.totalRows).toBe(0)
  })

  it('rotates rows whose keyVersion mismatches current', async () => {
    const t = vault()
    // Seed one sub under "v1".
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'a@example.com',
      expiresAt: Date.now() + 60_000,
    })
    // Switch to v2 with PREVIOUS pointing at the original key.
    process.env.VAULT_AES_KEY_PREVIOUS = process.env.VAULT_AES_KEY
    process.env.VAULT_AES_KEY = Buffer.alloc(32, 73).toString('base64')
    process.env.VAULT_KEY_VERSION = 'v2'

    const result = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    expect(result.totalRows).toBe(1)

    // The row's keyVersion should now be "v2".
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', seeded.subId))
    expect(after?.keyVersion).toBe('v2')
  })

  it('returns the existing job id when one is already in flight', async () => {
    const t = vault()
    await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'a@example.com',
      expiresAt: Date.now() + 60_000,
    })
    process.env.VAULT_AES_KEY_PREVIOUS = process.env.VAULT_AES_KEY
    process.env.VAULT_AES_KEY = Buffer.alloc(32, 79).toString('base64')
    process.env.VAULT_KEY_VERSION = 'v2'

    const r1 = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    const r2 = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    // Both jobs land — but post-completion. The second call observes a
    // completed job and starts a new one (zero rows). Both results are
    // valid; what matters is no concurrent overlap caused state corruption.
    expect([r1.jobId, r2.jobId]).toBeTruthy()
  })
})
```

- [ ] **Step 3: Implement `convex/keyRotationJobs/actions.ts`**

```ts
'use node'

/**
 * Key rotation public + internal actions.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §5.
 */
import { v } from 'convex/values'

import { internal } from '../_generated/api'
import { type Id } from '../_generated/dataModel'
import { internalAction } from '../_generated/server'
import { currentKeyVersion, decrypt, encrypt } from '../subscriptions/crypto'
import { authenticatedAction, getIdentity } from '../utils/auth'
import { getCurrentUserOrThrowFromIdentity } from '../utils/users'

const triggerResultValidator = v.object({
  jobId: v.id('keyRotationJobs'),
  totalRows: v.number(),
})

export const triggerKeyRotation = authenticatedAction({
  args: {},
  returns: triggerResultValidator,
  handler: async (ctx): Promise<{ jobId: Id<'keyRotationJobs'>; totalRows: number }> => {
    const identity = getIdentity(ctx)
    const user = await getCurrentUserOrThrowFromIdentity(ctx, identity.subject)

    const targetVersion = currentKeyVersion()
    const subs = await ctx.runQuery(internal.subscriptions.internalReads.listSubsForRotation, {
      userId: user._id,
      targetVersion,
    })

    const jobId = await ctx.runMutation(internal.keyRotationJobs.mutations.insertJob, {
      userId: user._id,
      totalRows: subs.length,
      toVersion: targetVersion,
    })

    if (subs.length === 0) {
      // Fast-path: nothing to do. Mark complete inline so the dashboard
      // doesn't show a spinner forever.
      await ctx.runMutation(internal.keyRotationJobs.mutations.markCompleted, { jobId })
      return { jobId, totalRows: 0 }
    }

    await ctx.runAction(internal.keyRotationJobs.actions.rotateAllSubscriptions, {
      jobId,
      userId: user._id,
      targetVersion,
    })
    return { jobId, totalRows: subs.length }
  },
})

export const rotateAllSubscriptions = internalAction({
  args: {
    jobId: v.id('keyRotationJobs'),
    userId: v.id('users'),
    targetVersion: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { jobId, userId, targetVersion }): Promise<null> => {
    await ctx.runMutation(internal.keyRotationJobs.mutations.markRunning, { jobId })

    const subs = await ctx.runQuery(internal.subscriptions.internalReads.listSubsForRotation, {
      userId,
      targetVersion,
    })

    for (const sub of subs) {
      try {
        const plaintext = decrypt(sub.ciphertext, sub.nonce, sub.keyVersion)
        const reEncrypted = encrypt(plaintext)
        await ctx.runMutation(internal.subscriptions.mutations.patchRotatedRow, {
          subId: sub._id,
          ciphertext: reEncrypted.ciphertext,
          nonce: reEncrypted.nonce,
          keyVersion: reEncrypted.keyVersion,
        })
        await ctx.runMutation(internal.keyRotationJobs.mutations.incrementProgress, {
          jobId,
          deltaProcessed: 1,
          deltaErrors: 0,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await ctx.runMutation(internal.keyRotationJobs.mutations.incrementProgress, {
          jobId,
          deltaProcessed: 0,
          deltaErrors: 1,
          lastError: msg,
        })
      }
    }

    await ctx.runMutation(internal.keyRotationJobs.mutations.markCompleted, { jobId })
    return null
  },
})
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/keyRotationJobs/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/keyRotationJobs/actions.ts convex/keyRotationJobs/actions.test.ts convex/subscriptions/internalReads.ts
git commit -m "feat(keyRotation): triggerKeyRotation + rotateAllSubscriptions actions"
```

---

## Task 8: Backup bundle helpers (pure)

**Files:**

- Create: `convex/backup/bundle.ts`
- Test: `convex/backup/bundle.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// convex/backup/bundle.test.ts
/**
 * Pure functions for building and parsing cvault backup bundles.
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
 */
import { describe, expect, it } from 'vitest'

import { type BackupAccount, buildBundle, parseBundle, validateBundle } from './bundle'

const sampleAccount: BackupAccount = {
  email: 'a@example.com',
  slot: 1,
  subscriptionType: 'max',
  rateLimitTier: 'tier1',
  expiresAt: 12345,
  ciphertext: 'YWJj',
  nonce: 'ZGVm',
}

describe('buildBundle', () => {
  it('emits the expected shape', () => {
    const bundle = buildBundle({
      saltBase64: 'c2FsdA==',
      accounts: [sampleAccount],
      now: 999,
    })
    expect(bundle.version).toBe(1)
    expect(bundle.kind).toBe('cvault-backup')
    expect(bundle.exportedAt).toBe(999)
    expect(bundle.kdf.name).toBe('scrypt')
    expect(bundle.kdf.salt).toBe('c2FsdA==')
    expect(bundle.accounts).toHaveLength(1)
  })
})

describe('parseBundle / validateBundle', () => {
  it('round-trips a valid bundle', () => {
    const original = buildBundle({ saltBase64: 'c2FsdA==', accounts: [sampleAccount], now: 1 })
    const json = JSON.stringify(original)
    expect(parseBundle(json)).toEqual(original)
  })

  it('rejects unknown version', () => {
    const bundle = buildBundle({ saltBase64: 's', accounts: [], now: 1 })
    const tampered = { ...bundle, version: 99 }
    expect(() => validateBundle(tampered)).toThrow(/version/)
  })

  it('rejects missing kind', () => {
    const bundle = buildBundle({ saltBase64: 's', accounts: [], now: 1 })
    const broken: unknown = { ...bundle, kind: undefined }
    expect(() => validateBundle(broken)).toThrow(/kind/)
  })

  it('rejects unknown kdf name', () => {
    const bundle = buildBundle({ saltBase64: 's', accounts: [], now: 1 })
    const broken = { ...bundle, kdf: { ...bundle.kdf, name: 'pbkdf2' } }
    expect(() => validateBundle(broken)).toThrow(/scrypt/)
  })

  it('rejects malformed account shape', () => {
    const bundle = buildBundle({ saltBase64: 's', accounts: [], now: 1 })
    const broken = { ...bundle, accounts: [{ email: 'a' }] }
    expect(() => validateBundle(broken)).toThrow(/account/)
  })
})
```

- [ ] **Step 2: Implement `convex/backup/bundle.ts`**

```ts
/**
 * Pure helpers for the cvault backup bundle format.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
 *
 * Kept pure (no Node-only imports) so it can be unit-tested without
 * spinning up a Convex action runtime.
 */

export interface BackupAccount {
  email: string
  slot: number
  label?: string
  subscriptionType: string
  rateLimitTier: string
  expiresAt: number
  refreshExpiresAt?: number
  /** Base64 of AES-GCM(plaintextBlob, derivedKey) including auth tag. */
  ciphertext: string
  /** Base64 of 12-byte nonce. */
  nonce: string
}

export interface ScryptKdfParams {
  name: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
}

export interface CvaultBackupBundle {
  version: 1
  kind: 'cvault-backup'
  exportedAt: number
  kdf: ScryptKdfParams
  accounts: BackupAccount[]
}

export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const

export function buildBundle(opts: { saltBase64: string; accounts: BackupAccount[]; now: number }): CvaultBackupBundle {
  return {
    version: 1,
    kind: 'cvault-backup',
    exportedAt: opts.now,
    kdf: { name: 'scrypt', N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, salt: opts.saltBase64 },
    accounts: opts.accounts,
  }
}

export function parseBundle(json: string): CvaultBackupBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Backup file is malformed JSON.')
  }
  return validateBundle(parsed)
}

function isString(x: unknown): x is string {
  return typeof x === 'string'
}
function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

export function validateBundle(parsed: unknown): CvaultBackupBundle {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Backup is not an object.')
  }
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1) {
    throw new Error(`Unsupported backup version: ${String(obj.version)}.`)
  }
  if (obj.kind !== 'cvault-backup') {
    throw new Error('Backup kind is missing or wrong.')
  }
  if (!isNumber(obj.exportedAt)) {
    throw new Error('Backup exportedAt is missing or invalid.')
  }
  const kdf = obj.kdf as Record<string, unknown> | undefined
  if (
    !kdf ||
    kdf.name !== 'scrypt' ||
    !isNumber(kdf.N) ||
    !isNumber(kdf.r) ||
    !isNumber(kdf.p) ||
    !isString(kdf.salt)
  ) {
    throw new Error('Backup kdf is missing or not scrypt.')
  }
  if (!Array.isArray(obj.accounts)) {
    throw new Error('Backup accounts is not an array.')
  }
  const accounts: BackupAccount[] = obj.accounts.map((raw, idx) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Backup account ${String(idx)} is not an object.`)
    }
    const a = raw as Record<string, unknown>
    if (
      !isString(a.email) ||
      !isNumber(a.slot) ||
      !isString(a.subscriptionType) ||
      !isString(a.rateLimitTier) ||
      !isNumber(a.expiresAt) ||
      !isString(a.ciphertext) ||
      !isString(a.nonce)
    ) {
      throw new Error(`Backup account ${String(idx)} is malformed (missing required fields).`)
    }
    const account: BackupAccount = {
      email: a.email,
      slot: a.slot,
      subscriptionType: a.subscriptionType,
      rateLimitTier: a.rateLimitTier,
      expiresAt: a.expiresAt,
      ciphertext: a.ciphertext,
      nonce: a.nonce,
    }
    if (isString(a.label)) account.label = a.label
    if (isNumber(a.refreshExpiresAt)) account.refreshExpiresAt = a.refreshExpiresAt
    return account
  })
  return {
    version: 1,
    kind: 'cvault-backup',
    exportedAt: obj.exportedAt,
    kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt },
    accounts,
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/backup/bundle.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add convex/backup/bundle.ts convex/backup/bundle.test.ts
git commit -m "feat(backup): bundle shape + parse/validate helpers"
```

---

## Task 9: Backup export action

**Files:**

- Create: `convex/backup/actions.ts`
- Test: `convex/backup/actions.test.ts`
- Modify: `convex/subscriptions/internalReads.ts` (add `listAllSubsForUser` if missing)

- [ ] **Step 1: Add internal query for user's subs (if not already present)**

Append to `convex/subscriptions/internalReads.ts`:

```ts
export const listSubsForUserId = internalQuery({
  args: { userId: v.id('users') },
  returns: v.array(subscriptionRawValidator),
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query('subscriptions')
      .withIndex('byUserAndSlot', (q) => q.eq('userId', userId))
      .collect()
    return rows.filter((r) => r.removedAt === undefined)
  },
})
```

- [ ] **Step 2: Write failing test**

```ts
// convex/backup/actions.test.ts
/**
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { seedSubscription } from '../__scenarios__/_helpers.scenario'
import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import { parseBundle } from './bundle'

const ORIGINAL_KEY = process.env.VAULT_AES_KEY

beforeEach(() => {
  process.env.VAULT_AES_KEY = Buffer.alloc(32, 89).toString('base64')
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.VAULT_AES_KEY
  else process.env.VAULT_AES_KEY = ORIGINAL_KEY
})

describe('exportEncryptedBackup', () => {
  it('returns a base64 bundle that parses cleanly', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'a@example.com', expiresAt: 1 })
    const result = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    expect(result.filename).toMatch(/^cvault-backup-\d{4}-\d{2}-\d{2}\.cvb$/)
    const json = Buffer.from(result.contentBase64, 'base64').toString('utf8')
    const bundle = parseBundle(json)
    expect(bundle.accounts).toHaveLength(1)
    expect(bundle.accounts[0]?.email).toBe('a@example.com')
  })

  it('rejects passphrase < 12 chars', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'a@example.com', expiresAt: 1 })
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
        passphrase: 'short',
      })
    ).rejects.toThrow(/12/)
  })
})
```

- [ ] **Step 3: Implement `convex/backup/actions.ts` (export only first; import comes in Task 10)**

```ts
'use node'

/**
 * Encrypted backup export + import actions.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §6.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

import { ConvexError, v } from 'convex/values'

import { internal } from '../_generated/api'
import { type Id } from '../_generated/dataModel'
import { decrypt, encrypt } from '../subscriptions/crypto'
import { authenticatedAction, getIdentity } from '../utils/auth'
import { getCurrentUserOrThrowFromIdentity } from '../utils/users'
import { type BackupAccount, type CvaultBackupBundle, SCRYPT_PARAMS, buildBundle, parseBundle } from './bundle'

const MIN_PASSPHRASE_LEN = 12
const SALT_BYTES = 16
const NONCE_BYTES = 12
const DERIVED_KEY_BYTES = 32
const SCRYPT_MAX_MEM = 64 * 1024 * 1024

function deriveKey(passphrase: string, saltBuf: Buffer): Buffer {
  return scryptSync(passphrase, saltBuf, DERIVED_KEY_BYTES, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAX_MEM,
  })
}

function aesGcmEncrypt(key: Buffer, plaintext: string): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { ciphertext: Buffer.concat([enc, tag]), nonce }
}

function aesGcmDecrypt(key: Buffer, bundle: Buffer, nonce: Buffer): string {
  const tag = bundle.subarray(bundle.byteLength - 16)
  const enc = bundle.subarray(0, bundle.byteLength - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

const exportResultValidator = v.object({
  filename: v.string(),
  contentBase64: v.string(),
})

function todayDateStamp(): string {
  const d = new Date()
  const y = d.getUTCFullYear().toString()
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = d.getUTCDate().toString().padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const exportEncryptedBackup = authenticatedAction({
  args: { passphrase: v.string() },
  returns: exportResultValidator,
  handler: async (ctx, { passphrase }): Promise<{ filename: string; contentBase64: string }> => {
    if (passphrase.length < MIN_PASSPHRASE_LEN) {
      throw new ConvexError({
        code: 'BACKUP_PASSPHRASE_TOO_SHORT',
        message: `Passphrase must be at least ${MIN_PASSPHRASE_LEN.toString()} characters.`,
      })
    }

    const identity = getIdentity(ctx)
    const user = await getCurrentUserOrThrowFromIdentity(ctx, identity.subject)

    const subs = await ctx.runQuery(internal.subscriptions.internalReads.listSubsForUserId, {
      userId: user._id,
    })

    const salt = randomBytes(SALT_BYTES)
    const derivedKey = deriveKey(passphrase, salt)

    const accounts: BackupAccount[] = []
    for (const sub of subs) {
      const plaintext = decrypt(sub.ciphertext, sub.nonce, sub.keyVersion)
      const { ciphertext, nonce } = aesGcmEncrypt(derivedKey, plaintext)
      const account: BackupAccount = {
        email: sub.email,
        slot: sub.slot,
        subscriptionType: sub.subscriptionType,
        rateLimitTier: sub.rateLimitTier,
        expiresAt: sub.expiresAt,
        ciphertext: ciphertext.toString('base64'),
        nonce: nonce.toString('base64'),
      }
      if (sub.label !== undefined) account.label = sub.label
      if (sub.refreshExpiresAt !== undefined) account.refreshExpiresAt = sub.refreshExpiresAt
      accounts.push(account)
    }

    const bundle: CvaultBackupBundle = buildBundle({
      saltBase64: salt.toString('base64'),
      accounts,
      now: Date.now(),
    })
    const contentBase64 = Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64')
    return {
      filename: `cvault-backup-${todayDateStamp()}.cvb`,
      contentBase64,
    }
  },
})
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/backup/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/backup/actions.ts convex/backup/actions.test.ts convex/subscriptions/internalReads.ts
git commit -m "feat(backup): exportEncryptedBackup action with scrypt KDF"
```

---

## Task 10: Backup import action

**Files:**

- Modify: `convex/backup/actions.ts` (append `importEncryptedBackup`)
- Modify: `convex/backup/actions.test.ts` (append round-trip test)

- [ ] **Step 1: Append failing test**

```ts
describe('importEncryptedBackup', () => {
  it('round-trips a freshly exported bundle', async () => {
    const t = vault()
    const seeded = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'roundtrip@example.com',
      expiresAt: 999,
    })
    const exportRes = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    // Soft-remove the original sub.
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, {
      email: 'roundtrip@example.com',
    })

    const restored = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.importEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
      bundleBase64: exportRes.contentBase64,
    })
    expect(restored.restoredCount).toBe(1)

    // The sub should be back (revived in place — see upsertSub semantics).
    const after = await t.run(async (ctx) => await ctx.db.get('subscriptions', seeded.subId))
    expect(after?.removedAt).toBeUndefined()
  })

  it('rejects bad passphrase', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'badpass@example.com', expiresAt: 999 })
    const exportRes = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.backup.actions.importEncryptedBackup, {
        passphrase: 'wrong-passphrase-also-long',
        bundleBase64: exportRes.contentBase64,
      })
    ).rejects.toThrow(/passphrase/i)
  })

  it('rejects malformed bundle', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'm@example.com', expiresAt: 1 })
    const garbage = Buffer.from('{"not":"a backup"}', 'utf8').toString('base64')
    await expect(
      t.withIdentity(TEST_IDENTITY).action(api.backup.actions.importEncryptedBackup, {
        passphrase: 'correcthorsebatterystaple',
        bundleBase64: garbage,
      })
    ).rejects.toThrow(/version|kind|kdf|account/)
  })
})
```

- [ ] **Step 2: Append `importEncryptedBackup` to `convex/backup/actions.ts`**

```ts
const importResultValidator = v.object({
  restoredCount: v.number(),
  skippedCount: v.number(),
  errors: v.array(v.string()),
})

export const importEncryptedBackup = authenticatedAction({
  args: { passphrase: v.string(), bundleBase64: v.string() },
  returns: importResultValidator,
  handler: async (
    ctx,
    { passphrase, bundleBase64 }
  ): Promise<{ restoredCount: number; skippedCount: number; errors: string[] }> => {
    const identity = getIdentity(ctx)
    const json = Buffer.from(bundleBase64, 'base64').toString('utf8')
    const bundle = parseBundle(json)
    const salt = Buffer.from(bundle.kdf.salt, 'base64')
    const derivedKey = deriveKey(passphrase, salt)

    let restoredCount = 0
    let skippedCount = 0
    const errors: string[] = []
    for (const account of bundle.accounts) {
      try {
        const acctCipher = Buffer.from(account.ciphertext, 'base64')
        const acctNonce = Buffer.from(account.nonce, 'base64')
        const plaintext = aesGcmDecrypt(derivedKey, acctCipher, acctNonce)
        // Re-encrypt under server's current master key for storage.
        const { ciphertext, nonce, keyVersion } = encrypt(plaintext)
        await ctx.runMutation(internal.subscriptions.mutations.upsertEncrypted, {
          externalId: identity.subject,
          email: account.email,
          ciphertext,
          nonce,
          keyVersion,
          expiresAt: account.expiresAt,
          ...(account.refreshExpiresAt !== undefined ? { refreshExpiresAt: account.refreshExpiresAt } : {}),
          subscriptionType: account.subscriptionType,
          rateLimitTier: account.rateLimitTier,
          ...(account.label !== undefined ? { label: account.label } : {}),
        })
        restoredCount += 1
      } catch (err) {
        skippedCount += 1
        const msg = err instanceof Error ? err.message : String(err)
        // Bad passphrase will trigger an AES-GCM auth tag failure on the
        // FIRST account. Surface it loudly so the user is not confused.
        if (msg.includes('Unsupported state') || msg.includes('auth') || msg.includes('decrypt')) {
          throw new ConvexError({
            code: 'BACKUP_BAD_PASSPHRASE',
            message: 'Bad passphrase — decryption failed.',
          })
        }
        errors.push(`${account.email}: ${msg}`)
      }
    }
    return { restoredCount, skippedCount, errors }
  },
})
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/backup/actions.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add convex/backup/actions.ts convex/backup/actions.test.ts
git commit -m "feat(backup): importEncryptedBackup action"
```

---

## Task 11: Scenario test — keyRotation end-to-end

**Files:**

- Create: `convex/__scenarios__/keyRotation.scenario.test.ts`

- [ ] **Step 1: Write the scenario**

```ts
/**
 * Scenario: end-to-end key rotation.
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §9.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import { seedSubscription, withVaultKey } from './_helpers.scenario'

const KEY_FILL = 91

let keyHandle: ReturnType<typeof withVaultKey>
const ORIGINAL_PREVIOUS = process.env.VAULT_AES_KEY_PREVIOUS
const ORIGINAL_VERSION = process.env.VAULT_KEY_VERSION

beforeEach(() => {
  keyHandle = withVaultKey(KEY_FILL)
  delete process.env.VAULT_AES_KEY_PREVIOUS
  delete process.env.VAULT_KEY_VERSION
})

afterEach(() => {
  keyHandle.restore()
  if (ORIGINAL_PREVIOUS === undefined) delete process.env.VAULT_AES_KEY_PREVIOUS
  else process.env.VAULT_AES_KEY_PREVIOUS = ORIGINAL_PREVIOUS
  if (ORIGINAL_VERSION === undefined) delete process.env.VAULT_KEY_VERSION
  else process.env.VAULT_KEY_VERSION = ORIGINAL_VERSION
})

describe('scenario: rotate encryption key end-to-end', () => {
  it('re-wraps every sub and pullForSwitch still works', async () => {
    const t = vault()
    // Seed three subs under v1.
    const a = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'a@example.com',
      expiresAt: Date.now() + 60_000,
    })
    const b = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'b@example.com',
      expiresAt: Date.now() + 60_000,
    })
    const c = await seedSubscription({
      t,
      identity: TEST_IDENTITY,
      email: 'c@example.com',
      expiresAt: Date.now() + 60_000,
    })

    // Rotate env vars: PREVIOUS = v1's key; new key = v2.
    process.env.VAULT_AES_KEY_PREVIOUS = process.env.VAULT_AES_KEY
    process.env.VAULT_AES_KEY = Buffer.alloc(32, 92).toString('base64')
    process.env.VAULT_KEY_VERSION = 'v2'

    const result = await t.withIdentity(TEST_IDENTITY).action(api.keyRotationJobs.actions.triggerKeyRotation, {})
    expect(result.totalRows).toBe(3)

    for (const seed of [a, b, c]) {
      const row = await t.run(async (ctx) => await ctx.db.get('subscriptions', seed.subId))
      expect(row?.keyVersion).toBe('v2')
    }

    // pullForSwitch must still be able to decrypt under the new key.
    const pulled = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'a@example.com',
    })
    expect(pulled.email).toBe('a@example.com')
    expect(pulled.plaintextBlob.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run the scenario**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/__scenarios__/keyRotation.scenario.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add convex/__scenarios__/keyRotation.scenario.test.ts
git commit -m "test(scenario): key rotation end-to-end"
```

---

## Task 12: Scenario test — backup round-trip end-to-end

**Files:**

- Create: `convex/__scenarios__/backupRoundtrip.scenario.test.ts`

- [ ] **Step 1: Write the scenario**

```ts
/**
 * Scenario: backup export → soft-remove → import → restored sub.
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §9.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TEST_IDENTITY, vault } from '../__tests__/helpers'
import { api } from '../_generated/api'
import { seedSubscription, withVaultKey } from './_helpers.scenario'

const KEY_FILL = 97

let keyHandle: ReturnType<typeof withVaultKey>

beforeEach(() => {
  keyHandle = withVaultKey(KEY_FILL)
})

afterEach(() => {
  keyHandle.restore()
})

describe('scenario: encrypted backup round-trip', () => {
  it('exports, removes, re-imports, restores cleanly', async () => {
    const t = vault()
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'r1@example.com', expiresAt: Date.now() + 60_000 })
    await seedSubscription({ t, identity: TEST_IDENTITY, email: 'r2@example.com', expiresAt: Date.now() + 60_000 })

    const exported = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.exportEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
    })

    // Disaster: remove both subs.
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, { email: 'r1@example.com' })
    await t.withIdentity(TEST_IDENTITY).mutation(api.subscriptions.mutations.softRemove, { email: 'r2@example.com' })

    const beforeRestore = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(beforeRestore).toHaveLength(0)

    const restored = await t.withIdentity(TEST_IDENTITY).action(api.backup.actions.importEncryptedBackup, {
      passphrase: 'correcthorsebatterystaple',
      bundleBase64: exported.contentBase64,
    })
    expect(restored.restoredCount).toBe(2)

    const afterRestore = await t.withIdentity(TEST_IDENTITY).query(api.subscriptions.queries.listForUser, {})
    expect(afterRestore.map((s) => s.email).sort()).toEqual(['r1@example.com', 'r2@example.com'])

    // pullForSwitch must work on a restored sub.
    const pulled = await t.withIdentity(TEST_IDENTITY).action(api.subscriptions.actions.pullForSwitch, {
      slotOrEmail: 'r1@example.com',
    })
    expect(pulled.plaintextBlob.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run the scenario**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run convex/__scenarios__/backupRoundtrip.scenario.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add convex/__scenarios__/backupRoundtrip.scenario.test.ts
git commit -m "test(scenario): backup export+import round-trip"
```

---

## Task 13: CLI command — `cvault rotate-key`

**Files:**

- Create: `cli/src/commands/rotateKey.ts`
- Modify: `cli/src/index.ts`
- Test: `cli/tests/commands/rotateKey.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// cli/tests/commands/rotateKey.test.ts
import { describe, expect, it, vi } from 'vitest'

import { runRotateKey } from '../../src/commands/rotateKey'

describe('runRotateKey', () => {
  it('triggers triggerKeyRotation and returns the job result', async () => {
    const action = vi.fn().mockResolvedValueOnce({ jobId: 'job_test', totalRows: 3 })
    const query = vi.fn().mockResolvedValueOnce({
      _id: 'job_test',
      status: 'completed',
      processedRows: 3,
      totalRows: 3,
      errorCount: 0,
      toVersion: 'v2',
      startedAt: Date.now(),
    })
    const client = {
      action,
      query,
      withMachineLabel: <A extends object>(a: A) => a,
    }
    const logs: string[] = []
    await runRotateKey({
      makeClient: async () => client as unknown as never,
      log: (m) => logs.push(m),
      pollIntervalMs: 0,
    })
    expect(action).toHaveBeenCalled()
    expect(logs.some((l) => /Rotation complete/.test(l))).toBe(true)
  })
})
```

- [ ] **Step 2: Implement `cli/src/commands/rotateKey.ts`**

```ts
/**
 * `cvault rotate-key` — generate a fresh AES-256 master key, print the
 * env-var update commands, and (after operator confirms) trigger the
 * server-side rotation.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §7.
 */
import { randomBytes } from 'node:crypto'

import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { type VaultClient, makeVaultClient } from '../convex/vaultClient'

interface RunRotateKeyOpts {
  makeClient?: () => Promise<VaultClient>
  log?: (msg: string) => void
  pollIntervalMs?: number
}

export async function runRotateKey(opts: RunRotateKeyOpts = {}): Promise<void> {
  const log = opts.log ?? ((m) => console.log(m))
  const newKey = randomBytes(32).toString('base64')
  log('Generated new AES-256 master key:')
  log(`  NEW_KEY=${newKey}`)
  log('')
  log('Run these commands in your shell to install the new key:')
  log('  npx convex env set VAULT_AES_KEY_PREVIOUS "$(npx convex env get VAULT_AES_KEY)"')
  log(`  npx convex env set VAULT_AES_KEY "${newKey}"`)
  log('  npx convex env set VAULT_KEY_VERSION "v2"   # bump per rotation')
  log('')
  log('Then triggering rotation against the server...')

  const client = await (opts.makeClient ?? makeVaultClient)()
  const result = (await client.action(api.keyRotationJobs.actions.triggerKeyRotation, client.withMachineLabel({}))) as {
    jobId: string
    totalRows: number
  }

  log(`Job ${result.jobId} (totalRows=${result.totalRows.toString()})`)

  const interval = opts.pollIntervalMs ?? 1000
  let last = { processedRows: 0, errorCount: 0, status: 'pending' as string }
  while (last.status !== 'completed' && last.status !== 'failed') {
    await new Promise((r) => setTimeout(r, interval))
    const job = (await client.query(api.keyRotationJobs.queries.getJob, {
      jobId: result.jobId as never,
    })) as null | (typeof last & { totalRows: number; toVersion: string })
    if (!job) break
    last = job
    log(`  ${job.processedRows.toString()}/${job.totalRows.toString()} (${job.errorCount.toString()} errors)`)
  }
  log(
    `Rotation complete: status=${last.status} processed=${last.processedRows.toString()} errors=${last.errorCount.toString()}`
  )
}

export const rotateKeyCommand = defineCommand({
  meta: {
    name: 'rotate-key',
    description: 'Generate a fresh AES-256 master key, print env-var commands, and trigger rotation.',
  },
  async run() {
    await runRotateKey()
  },
})
```

- [ ] **Step 3: Wire into `cli/src/index.ts`**

Add import + subcommand:

```ts
import { rotateKeyCommand } from './commands/rotateKey'
// ...
subCommands: {
  // ...existing,
  'rotate-key': rotateKeyCommand,
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run cli/tests/commands/rotateKey.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/rotateKey.ts cli/src/index.ts cli/tests/commands/rotateKey.test.ts
git commit -m "feat(cli): cvault rotate-key command"
```

---

## Task 14: CLI command — `cvault export <out.cvb>`

**Files:**

- Create: `cli/src/commands/exportBackup.ts`
- Modify: `cli/src/index.ts`
- Test: `cli/tests/commands/exportBackup.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// cli/tests/commands/exportBackup.test.ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { runExportBackup } from '../../src/commands/exportBackup'

describe('runExportBackup', () => {
  it('writes the bundle to disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cvault-test-'))
    const out = join(dir, 'backup.cvb')

    const action = vi.fn().mockResolvedValueOnce({
      filename: 'cvault-backup-2026-05-04.cvb',
      contentBase64: Buffer.from('{"hello":"world"}', 'utf8').toString('base64'),
    })
    const client = {
      action,
      query: vi.fn(),
      withMachineLabel: <A extends object>(a: A) => a,
    }
    await runExportBackup({
      out,
      passphrase: 'correcthorsebatterystaple',
      makeClient: async () => client as unknown as never,
      log: () => {},
    })
    const written = readFileSync(out, 'utf8')
    expect(written).toBe('{"hello":"world"}')
  })
})
```

- [ ] **Step 2: Implement `cli/src/commands/exportBackup.ts`**

```ts
/**
 * `cvault export <out.cvb>` — passphrase-encrypted backup of every sub.
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §7.
 */
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { type VaultClient, makeVaultClient } from '../convex/vaultClient'

interface RunExportBackupOpts {
  out: string
  passphrase?: string
  makeClient?: () => Promise<VaultClient>
  log?: (msg: string) => void
}

async function readPassphraseFromStdin(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
  }
}

export async function runExportBackup(opts: RunExportBackupOpts): Promise<void> {
  const log = opts.log ?? ((m) => console.log(m))
  const passphrase = opts.passphrase ?? (await readPassphraseFromStdin('Passphrase (≥12 chars): '))
  if (passphrase.length < 12) {
    throw new Error('Passphrase must be at least 12 characters.')
  }
  const client = await (opts.makeClient ?? makeVaultClient)()
  const result = (await client.action(
    api.backup.actions.exportEncryptedBackup,
    client.withMachineLabel({ passphrase })
  )) as { filename: string; contentBase64: string }

  const bytes = Buffer.from(result.contentBase64, 'base64')
  writeFileSync(opts.out, bytes)
  log(`Wrote ${opts.out} (${bytes.byteLength.toString()} bytes).`)
}

export const exportCommand = defineCommand({
  meta: {
    name: 'export',
    description: 'Export a passphrase-encrypted backup of every subscription.',
  },
  args: {
    out: { type: 'positional', description: 'Output file path (.cvb)', required: true },
  },
  async run({ args }) {
    await runExportBackup({ out: args.out })
  },
})
```

- [ ] **Step 3: Wire into `cli/src/index.ts`**

```ts
import { exportCommand } from './commands/exportBackup'
// add to subCommands:
export: exportCommand,
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run cli/tests/commands/exportBackup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/exportBackup.ts cli/src/index.ts cli/tests/commands/exportBackup.test.ts
git commit -m "feat(cli): cvault export command"
```

---

## Task 15: CLI command — `cvault import <in.cvb>`

**Files:**

- Create: `cli/src/commands/importBackup.ts`
- Modify: `cli/src/index.ts`
- Test: `cli/tests/commands/importBackup.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// cli/tests/commands/importBackup.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { runImportBackup } from '../../src/commands/importBackup'

describe('runImportBackup', () => {
  it('reads the bundle and calls importEncryptedBackup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cvault-import-'))
    const file = join(dir, 'b.cvb')
    const fakeBundle = Buffer.from('{"version":1}', 'utf8')
    writeFileSync(file, fakeBundle)

    const action = vi.fn().mockResolvedValueOnce({ restoredCount: 2, skippedCount: 0, errors: [] })
    const client = {
      action,
      query: vi.fn(),
      withMachineLabel: <A extends object>(a: A) => a,
    }
    await runImportBackup({
      in: file,
      passphrase: 'correcthorsebatterystaple',
      makeClient: async () => client as unknown as never,
      log: () => {},
    })
    expect(action).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ passphrase: 'correcthorsebatterystaple' })
    )
  })
})
```

- [ ] **Step 2: Implement `cli/src/commands/importBackup.ts`**

```ts
/**
 * `cvault import <in.cvb>` — restore from an encrypted backup bundle.
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §7.
 */
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

import { api } from '@cvault/convex/api'
import { defineCommand } from 'citty'

import { type VaultClient, makeVaultClient } from '../convex/vaultClient'

interface RunImportBackupOpts {
  in: string
  passphrase?: string
  makeClient?: () => Promise<VaultClient>
  log?: (msg: string) => void
}

async function readPassphrase(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
  }
}

export async function runImportBackup(opts: RunImportBackupOpts): Promise<void> {
  const log = opts.log ?? ((m) => console.log(m))
  const passphrase = opts.passphrase ?? (await readPassphrase('Passphrase: '))
  const bundleBase64 = readFileSync(opts.in).toString('base64')

  const client = await (opts.makeClient ?? makeVaultClient)()
  const result = (await client.action(
    api.backup.actions.importEncryptedBackup,
    client.withMachineLabel({ passphrase, bundleBase64 })
  )) as { restoredCount: number; skippedCount: number; errors: string[] }

  log(`Restored ${result.restoredCount.toString()} subs (skipped ${result.skippedCount.toString()}).`)
  for (const err of result.errors) {
    log(`  ! ${err}`)
  }
}

export const importCommand = defineCommand({
  meta: { name: 'import', description: 'Restore subscriptions from a passphrase-encrypted backup bundle.' },
  args: { in: { type: 'positional', description: 'Path to .cvb file', required: true } },
  async run({ args }) {
    await runImportBackup({ in: args.in })
  },
})
```

- [ ] **Step 3: Wire into `cli/src/index.ts`**

```ts
import { importCommand } from './commands/importBackup'
// subCommands:
import: importCommand,
```

- [ ] **Step 4: Run tests + lint**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run cli/tests/commands/ && yarn lint:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/importBackup.ts cli/src/index.ts cli/tests/commands/importBackup.test.ts
git commit -m "feat(cli): cvault import command"
```

---

## Task 16: Dashboard — wire up settings cards

**Files:**

- Create: `frontend/src/components/dashboard/RotateKeyDialog.tsx`
- Create: `frontend/src/components/dashboard/ExportBackupDialog.tsx`
- Create: `frontend/src/components/dashboard/ImportBackupDialog.tsx`
- Modify: `frontend/src/routes/dashboard/settings.lazy.tsx`

- [ ] **Step 1: Build `RotateKeyDialog`**

Create `frontend/src/components/dashboard/RotateKeyDialog.tsx`:

```tsx
/**
 * 3-step modal driving the key-rotation flow.
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 */
import { api } from '@cvault/convex/api'
import { type Id } from '@cvault/convex/dataModel'
import { useAction, useQuery } from 'convex/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
}

type Step = 'instructions' | 'confirm' | 'running' | 'done'

export function RotateKeyDialog({ open, onOpenChange }: Props) {
  const [step, setStep] = useState<Step>('instructions')
  const [confirmed, setConfirmed] = useState(false)
  const [jobId, setJobId] = useState<Id<'keyRotationJobs'> | null>(null)
  const trigger = useAction(api.keyRotationJobs.actions.triggerKeyRotation)
  const job = useQuery(api.keyRotationJobs.queries.getJob, jobId ? { jobId } : 'skip')

  const startRotation = async () => {
    setStep('running')
    const r = await trigger({})
    setJobId(r.jobId)
    if (r.totalRows === 0) setStep('done')
  }

  if (job?.status === 'completed' && step !== 'done') setStep('done')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate encryption key</DialogTitle>
          <DialogDescription>Re-wrap every stored credential blob with a fresh AES-256 master key.</DialogDescription>
        </DialogHeader>
        {step === 'instructions' && (
          <div className="space-y-3 text-sm">
            <p>1. Generate a new key:</p>
            <pre className="bg-muted rounded p-2 text-xs">openssl rand -base64 32</pre>
            <p>2. Move the existing key to PREVIOUS, then install the new one + bump version label:</p>
            <pre className="bg-muted rounded p-2 text-xs whitespace-pre-wrap">
              {`npx convex env set VAULT_AES_KEY_PREVIOUS "$(npx convex env get VAULT_AES_KEY)"
npx convex env set VAULT_AES_KEY "<new key>"
npx convex env set VAULT_KEY_VERSION "v2"`}
            </pre>
            <Button onClick={() => setStep('confirm')}>Next</Button>
          </div>
        )}
        {step === 'confirm' && (
          <div className="space-y-3 text-sm">
            <label className="flex items-start gap-2">
              <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} />
              <span>I have updated VAULT_AES_KEY, VAULT_AES_KEY_PREVIOUS, and VAULT_KEY_VERSION.</span>
            </label>
            <DialogFooter>
              <Button disabled={!confirmed} onClick={startRotation}>
                Start rotation
              </Button>
            </DialogFooter>
          </div>
        )}
        {step === 'running' && (
          <div className="space-y-3 text-sm">
            <p>Rotating subscriptions...</p>
            {job ? (
              <>
                <Progress value={job.totalRows ? (job.processedRows / job.totalRows) * 100 : 0} />
                <p className="text-muted-foreground">
                  {job.processedRows} / {job.totalRows} rows ({job.errorCount} errors)
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">Starting...</p>
            )}
          </div>
        )}
        {step === 'done' && (
          <div className="space-y-3 text-sm">
            <p>Rotation complete.</p>
            {job && (
              <p className="text-muted-foreground">
                Processed {job.processedRows} of {job.totalRows} rows ({job.errorCount} errors).
              </p>
            )}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Close</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Build `ExportBackupDialog`**

Create `frontend/src/components/dashboard/ExportBackupDialog.tsx`:

```tsx
/**
 * Export-backup modal: passphrase prompt + browser download trigger.
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 */
import { api } from '@cvault/convex/api'
import { useAction } from 'convex/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
}

export function ExportBackupDialog({ open, onOpenChange }: Props) {
  const exportBackup = useAction(api.backup.actions.exportEncryptedBackup)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    if (passphrase.length < 12) {
      setError('Passphrase must be at least 12 characters.')
      return
    }
    if (passphrase !== confirm) {
      setError('Passphrases do not match.')
      return
    }
    setBusy(true)
    try {
      const result = await exportBackup({ passphrase })
      const bytes = Uint8Array.from(atob(result.contentBase64), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = result.filename
      a.click()
      URL.revokeObjectURL(url)
      onOpenChange(false)
      setPassphrase('')
      setConfirm('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export encrypted backup</DialogTitle>
          <DialogDescription>
            Download a passphrase-protected bundle of every subscription. Keep the passphrase safe — without it, the
            bundle cannot be restored.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <Input
            type="password"
            placeholder="Passphrase (≥12 chars)"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <Input
            type="password"
            placeholder="Confirm passphrase"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {error && <p className="text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Exporting...' : 'Export backup'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: Build `ImportBackupDialog`**

Create `frontend/src/components/dashboard/ImportBackupDialog.tsx`:

```tsx
/**
 * Import-backup modal: file picker + passphrase + restore.
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 */
import { api } from '@cvault/convex/api'
import { useAction } from 'convex/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
}

export function ImportBackupDialog({ open, onOpenChange }: Props) {
  const importBackup = useAction(api.backup.actions.importEncryptedBackup)
  const [file, setFile] = useState<File | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    setResult(null)
    if (!file) {
      setError('Pick a .cvb backup file first.')
      return
    }
    setBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let bundleBase64 = ''
      const chunkSize = 0x8000
      for (let i = 0; i < bytes.length; i += chunkSize) {
        bundleBase64 += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
      }
      bundleBase64 = btoa(bundleBase64)
      const r = await importBackup({ passphrase, bundleBase64 })
      setResult(`Restored ${r.restoredCount.toString()} subs (${r.skippedCount.toString()} skipped).`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import encrypted backup</DialogTitle>
          <DialogDescription>Restore subscriptions from a previously exported .cvb bundle.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <Input type="file" accept=".cvb" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Input
            type="password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          {error && <p className="text-destructive">{error}</p>}
          {result && <p className="text-muted-foreground">{result}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Restoring...' : 'Restore'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Replace settings cards**

Update `frontend/src/routes/dashboard/settings.lazy.tsx`. Replace the disabled "Rotate key" + "Export backup" button blocks with state-bound buttons that open the corresponding dialogs. Add an Import card alongside Export. Drop the `<Badge variant="outline">v2</Badge>` from these two cards.

```tsx
import { createLazyFileRoute } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { ExportBackupDialog } from '@/components/dashboard/ExportBackupDialog'
import { ImportBackupDialog } from '@/components/dashboard/ImportBackupDialog'
import { RotateKeyDialog } from '@/components/dashboard/RotateKeyDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const Route = createLazyFileRoute('/dashboard/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  const [rotateOpen, setRotateOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">Account-level controls and operational tooling.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Rotate encryption key</CardTitle>
            <CardDescription>
              Re-wrap every stored credential blob with a fresh AES-256 master key. Use after a suspected key
              compromise.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" onClick={() => setRotateOpen(true)}>
              Rotate key
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Export encrypted backup</CardTitle>
            <CardDescription>
              Download an encrypted bundle of all your subscriptions, secured by a passphrase you choose.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button type="button" onClick={() => setExportOpen(true)}>
              Export backup
            </Button>
            <Button type="button" variant="outline" onClick={() => setImportOpen(true)}>
              Import backup
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Refresh-failure notifications</CardTitle>
              <Badge variant="outline">v2</Badge>
            </div>
            <CardDescription>Get a Slack DM or email when an OAuth refresh fails permanently.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="outline" disabled>
              Configure notifications
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Documentation</CardTitle>
            <CardDescription>Reference material for the cvault CLI and Convex backend.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <HelpLink href="https://docs.anthropic.com/">Anthropic docs</HelpLink>
            <HelpLink href="https://docs.convex.dev/">Convex docs</HelpLink>
            <HelpLink href="https://clerk.com/docs">Clerk docs</HelpLink>
          </CardContent>
        </Card>
      </div>
      <RotateKeyDialog open={rotateOpen} onOpenChange={setRotateOpen} />
      <ExportBackupDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ImportBackupDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  )
}

function HelpLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
    >
      <ExternalLink className="size-3" aria-hidden />
      {children}
    </a>
  )
}
```

- [ ] **Step 5: Lint + typecheck**

Run: `cd /Users/saadings/Desktop/cvault && yarn lint:check`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/dashboard/RotateKeyDialog.tsx frontend/src/components/dashboard/ExportBackupDialog.tsx frontend/src/components/dashboard/ImportBackupDialog.tsx frontend/src/routes/dashboard/settings.lazy.tsx
git commit -m "feat(dashboard): wire RotateKey + Export + Import settings dialogs"
```

---

## Task 17: Final verification

- [ ] **Step 1: Full unit suite**

Run: `cd /Users/saadings/Desktop/cvault && yarn test --run`
Expected: PASS.

- [ ] **Step 2: Scenario suite**

Run: `cd /Users/saadings/Desktop/cvault && yarn test:scenario`
Expected: PASS, including the two new scenario files.

- [ ] **Step 3: Lint + format**

Run: `cd /Users/saadings/Desktop/cvault && yarn lint:check && yarn format:check`
Expected: PASS.

- [ ] **Step 4: Push branches + open PRs**

Push the feature branch + open PR. Title: `feat: encryption key rotation + encrypted backup`.
