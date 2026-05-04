# cvault — Key Rotation + Encrypted Backup

**Date:** 2026-05-04
**Status:** Approved (no feature flags per user direction 2026-05-04)
**Owner:** Stefan (single user, multi-machine)

---

## 1. Problem

The `2026-05-02-cvault-design.md` v1 spec deferred two operational features:

1. **Encryption key rotation** — if `VAULT_AES_KEY` is compromised or lost, the only recovery today is `cvault add` on every machine for every account. Painful + lossy (any account whose machine no longer has fresh credentials becomes unrecoverable).
2. **Encrypted backup export** — if the Convex deployment is destroyed (account deletion, region outage, accidental `convex deploy` against the wrong env), all credentials are gone. There is no offline copy.

Settings page placeholders exist at `frontend/src/routes/dashboard/settings.lazy.tsx` (cards 1 + 2). Both buttons are currently disabled with `Badge variant="outline">v2"`. This spec wires them up.

Per user direction 2026-05-04: **no feature flags**. Both features ship enabled for any signed-in caller. Auth (Clerk JWT) + per-user scoping is the only access control.

---

## 2. Scope

### In scope

- **Key rotation**:
  - Schema field `keyVersion` per subscription row (string identifier; missing/`undefined` treated as legacy "v1").
  - Two env vars: `VAULT_AES_KEY` (current writes) and `VAULT_AES_KEY_PREVIOUS` (decrypt-only, optional).
  - `VAULT_KEY_VERSION` env var for the human-readable version label of the _current_ key (default `"v1"`).
  - `decrypt()` resolves the right key from the row's `keyVersion`; falls back to `VAULT_AES_KEY_PREVIOUS` when the row's version doesn't match the current label.
  - Internal action `rotateAllSubscriptions` paginates and re-wraps every row whose `keyVersion !== currentVersion`. Idempotent (safe to re-run; no-ops a row that's already current).
  - Public action `triggerKeyRotation` (authenticated; owner-only — i.e. caller's user) that schedules `rotateAllSubscriptions` against the caller's own rows. Returns a `rotationJobId` so the dashboard can poll progress.
  - New `keyRotationJobs` table tracks `{userId, status, totalRows, processedRows, errorCount, startedAt, completedAt, currentVersion}` for progress display.
  - CLI: `cvault rotate-key` (admin helper) — generates a fresh base64 key, prints the env-var update commands the operator must run (`npx convex env set ...`), then waits for confirmation and triggers the rotation action.
  - Dashboard: wire up "Rotate key" button on `/dashboard/settings`. Shows a 3-step modal: (1) generate key, (2) confirm operator updated env vars, (3) trigger rotation + show progress bar.

- **Encrypted backup**:
  - Public action `exportEncryptedBackup({ passphrase })` returns a base64-encoded bundle file.
  - Bundle format (v1):
    ```json
    {
      "version": 1,
      "kind": "cvault-backup",
      "exportedAt": <ms>,
      "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "salt": "<base64>" },
      "accounts": [
        {
          "email": "...",
          "slot": 1,
          "label": "...",
          "subscriptionType": "max",
          "rateLimitTier": "tier1",
          "expiresAt": <ms>,
          "refreshExpiresAt": <ms?>,
          "ciphertext": "<base64 of AES-GCM(plaintextBlob, derivedKey)>",
          "nonce": "<base64 of 12-byte nonce>"
        }
      ]
    }
    ```
  - Each account ciphertext re-encrypts the same plaintext OAuth blob the server already holds, but keyed under `scrypt(passphrase, salt)` instead of `VAULT_AES_KEY`. Bundle is portable: anyone holding the passphrase can decrypt offline (no cvault deployment needed).
  - Public action `importEncryptedBackup({ passphrase, bundleBase64 })` validates + decrypts + restores via the existing `upsertSub` path. Owner-scoped (restores only into the caller's account).
  - CLI: `cvault export <out.cvb>` and `cvault import <in.cvb>` — passphrase prompted via stdin (no echo). Uses the actions above.
  - Dashboard: wire up "Export backup" button on `/dashboard/settings`. Modal prompts for passphrase, calls action, triggers browser file download. Add an "Import backup" button alongside.

### Out of scope (explicit)

- **Feature flags** — deferred per user direction 2026-05-04.
- **Multi-tenant rotation** (rotate all users' rows from one operator action) — current design is owner-only. A platform-admin path can land in a follow-up if needed.
- **Auto-rotation schedule** (e.g. every 90 days). Manual trigger only in v1.
- **Bundle versioning beyond v1**. Future bundle versions add a discriminated `version` field — exporters always write v1; the importer rejects anything else with a clear error.
- **Rotation rollback** — once a row is re-wrapped under the new key, there is no "undo" to the old key from the action. The operator must keep `VAULT_AES_KEY_PREVIOUS` set throughout the rotation window; if rolling back is needed before the operator unsets `PREVIOUS`, the operator can swap the env vars back and re-run the action.

---

## 3. Schema changes

### `convex/subscriptions/schema.ts`

Add one optional field:

```ts
keyVersion: v.optional(v.string()),
```

`undefined` semantics: row was written before key-versioning landed (i.e. encrypted under whatever `VAULT_AES_KEY` happened to be at write time). Treated identically to `keyVersion === "v1"` by `decrypt()`. New writes always set `keyVersion` to the current `VAULT_KEY_VERSION` env var (default `"v1"`).

### New table `convex/keyRotationJobs/schema.ts`

```ts
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

Used to render progress in the dashboard rotation modal. Polled at 1s intervals while the rotation runs.

---

## 4. Crypto changes (`convex/subscriptions/crypto.ts`)

Replace the single-key loader with a version-aware one:

```ts
const DEFAULT_VERSION = 'v1'

export function currentKeyVersion(): string {
  return process.env.VAULT_KEY_VERSION ?? DEFAULT_VERSION
}

function loadKeyForVersion(version: string): Buffer {
  const current = currentKeyVersion()
  // The "current" key uses VAULT_AES_KEY regardless of label.
  const raw = version === current ? process.env.VAULT_AES_KEY : process.env.VAULT_AES_KEY_PREVIOUS
  if (!raw) {
    throw new Error(
      `No master key available for keyVersion=${version} (currentVersion=${current}). ` +
        `Set ${version === current ? 'VAULT_AES_KEY' : 'VAULT_AES_KEY_PREVIOUS'} and retry.`
    )
  }
  // ...same length validation as before
}
```

`encrypt()` always uses the current key; returns `{ciphertext, nonce, keyVersion}`.
`decrypt()` accepts an optional `keyVersion` arg (defaults to `DEFAULT_VERSION` for legacy rows).

Backwards compat: every existing call site to `encrypt`/`decrypt` keeps working. Encrypt callers store `keyVersion` returned from `encrypt`. Decrypt callers pass the row's `keyVersion`.

### Why two env vars instead of `VAULT_AES_KEY_<version>`

A naive `VAULT_AES_KEY_v3` indirection couples the key name to the version label. Operators rotating from "v3" to "v4" would need to set yet another env var, leaving stale ones forever. The two-slot model (`VAULT_AES_KEY` = current, `VAULT_AES_KEY_PREVIOUS` = the one we are rotating away from) means rotation always involves at most two keys. Once rotation completes, operator removes `VAULT_AES_KEY_PREVIOUS`.

---

## 5. Rotation flow

Operator drives the env-var rotation; the action handles the data.

```
1. Operator: openssl rand -base64 32  → NEW_KEY
2. Operator: npx convex env set VAULT_AES_KEY_PREVIOUS "$OLD_KEY"
3. Operator: npx convex env set VAULT_AES_KEY "$NEW_KEY"
4. Operator: npx convex env set VAULT_KEY_VERSION "v2"   (or whatever label)
5. Operator/User: clicks "Rotate key" in dashboard → calls triggerKeyRotation
6. Server: scheduler.runAfter(0, internal.subscriptions.actions.rotateAllSubscriptions, {jobId, userId})
7. Action loops: fetch next batch (page size 50) of subs where keyVersion != current
   for each: decrypt(row.ciphertext, row.nonce, row.keyVersion ?? "v1")
             → encrypt(plaintext)  // uses current
             → patchRotatedRow({subId, ciphertext, nonce, keyVersion: current})
   patches keyRotationJobs.processedRows after each batch
8. When done (no more rows): mark job completed, return.
9. Operator: npx convex env unset VAULT_AES_KEY_PREVIOUS  (only after job.status === 'completed')
```

### Failure modes

- **Decrypt fails on a row mid-rotation** (e.g. PREVIOUS env var was wrong): increment `errorCount`, log to `refreshLog` with `outcome:'failure'`, skip the row, continue. The job ends `status:'completed'` with `errorCount > 0` — operator must investigate.
- **Action timeout / restart**: the action is idempotent (filters on `keyVersion != current`), so a re-run picks up where the previous left off. The job row is updated with the new run's start; old job rows are kept for audit.
- **New write lands mid-rotation**: writes always use the current key + version. The rotation loop's filter naturally skips them. No race.
- **Operator forgets to set PREVIOUS**: `decrypt` throws on legacy/previous-version rows. The action catches per row, logs, increments `errorCount`. Operator sees the job complete with errors and remediation hint.

### Concurrency

A `triggerKeyRotation` while another job is `pending` or `running` for the same user returns the existing job's id (no second job spawned). Enforced by a quick query on `byUserAndStartedAt` desc-1.

---

## 6. Backup export flow

### Server-side (action `exportEncryptedBackup`)

1. Authenticated; resolve `userId` from Clerk identity.
2. Validate passphrase: must be a string ≥ 12 characters. (UX hint: surfaces in CLI + dashboard pre-flight check.)
3. Generate fresh 16-byte salt: `randomBytes(16)`.
4. Derive 32-byte key: `scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })`.
   - Cost params chosen for ~1 second on a modern Mac (per OWASP scrypt recs as of 2026).
5. Fetch all live subs for `userId` (`removedAt === undefined`) via internal query.
6. For each sub: `decrypt(ciphertext, nonce, keyVersion)` → re-encrypt the plaintext with the derived key (fresh 12-byte nonce per account).
7. Build bundle JSON with shape from §2.
8. Stringify + base64-encode.
9. Return `{ filename: "cvault-backup-<YYYY-MM-DD>.cvb", contentBase64 }`.

### Server-side (action `importEncryptedBackup`)

1. Authenticated.
2. Decode base64 → parse JSON. Validate shape with Zod (or hand-rolled type guards). Reject unknown `version`, missing `kdf`, malformed accounts.
3. Re-derive key from `bundle.kdf.salt` + supplied passphrase. (Bundle's `kdf.salt` is per-bundle — different export = different salt — so the same passphrase yields different derived keys.)
4. For each account:
   - Decrypt ciphertext under derived key. Throws on bad passphrase (GCM auth tag fails).
   - Re-encrypt plaintext under server's current `VAULT_AES_KEY` + current `keyVersion`.
   - Call `internal.subscriptions.mutations.upsertEncrypted` with the resulting ciphertext + sub metadata.
5. Return `{ restoredCount, skippedCount, errors: [...] }`.

### Why scrypt over PBKDF2 / Argon2

- **PBKDF2**: weak — high parallelism on GPUs/ASICs makes brute force much cheaper.
- **Argon2**: strongest, but no Node built-in — requires npm dep + native build, which clashes with Convex deployment portability.
- **scrypt**: built into `node:crypto`, memory-hard (defeats GPU brute force), well-vetted. The right pick.

### Why per-account encryption inside the bundle

Alternative: encrypt the entire account list as one big ciphertext.

We chose per-account because:

- **Partial corruption recovery**: a flipped bit in one account's ciphertext only loses that account.
- **Smaller decrypt unit** when one account is needed offline.
- **Future-proofing**: lets us add per-account metadata flags (e.g. `archived: true`) without re-encrypting everything.

The cost is one extra nonce per account (~12 bytes), which is negligible.

---

## 7. CLI commands

### `cvault rotate-key`

```bash
$ cvault rotate-key
Generating a new AES-256 master key...

  NEW_KEY=A1B2C3D4...   (base64, 32 bytes)

Run these commands in your shell, then re-run `cvault rotate-key` to start
the rotation:

  npx convex env set VAULT_AES_KEY_PREVIOUS "$(npx convex env get VAULT_AES_KEY)"
  npx convex env set VAULT_AES_KEY "A1B2C3D4..."
  npx convex env set VAULT_KEY_VERSION "v2"

If you have already run those, type `yes` to start the rotation: yes
Triggering rotation...
Job rotation_xyz_123 started.
  [████████████████████░░░░░░░░░░] 67% (34/50)
  Done. 50 rows re-wrapped, 0 errors.
```

### `cvault export <out.cvb>`

```bash
$ cvault export ./mybackup.cvb
Passphrase (≥12 chars): ************
Confirm passphrase: ************
Exporting 5 subscriptions...
Wrote ./mybackup.cvb (3.1 KB).
```

### `cvault import <in.cvb>`

```bash
$ cvault import ./mybackup.cvb
Passphrase: ************
Restored 5 subscriptions:
  ✓ stefan@example.com  (slot 1)
  ✓ stefan+work@example.com  (slot 2)
  ...
```

---

## 8. Dashboard wiring

### `/dashboard/settings`

Both cards already exist in `frontend/src/routes/dashboard/settings.lazy.tsx`. Replace the disabled button + `v2` badge with active controls:

#### Rotate Key card

- "Rotate key" button → opens `RotateKeyDialog`.
- Dialog steps:
  1. **Generate**: shows the new key (copy-to-clipboard) + the 3 `npx convex env set` commands.
  2. **Confirm**: checkbox "I have updated VAULT_AES_KEY, VAULT_AES_KEY_PREVIOUS, and VAULT_KEY_VERSION". Continue button disabled until checked.
  3. **Run**: calls `triggerKeyRotation`. Polls `getRotationJob` every 1s. Renders progress bar + processedRows / totalRows. Surfaces errorCount on completion.

#### Export Backup card

- "Export backup" button → opens `ExportBackupDialog`.
- Dialog: passphrase + confirm passphrase. Submit calls `exportEncryptedBackup`. Triggers browser download via `Blob` + `URL.createObjectURL`.
- Add an "Import backup" button below: file picker + passphrase. Calls `importEncryptedBackup`. Renders restored / skipped counts.

---

## 9. Test plan

### Unit tests (vitest, `convex/subscriptions/crypto.node.test.ts` + new `keyVersioning.test.ts`)

- `currentKeyVersion()` returns `VAULT_KEY_VERSION` when set, `"v1"` when not.
- `encrypt()` returns `keyVersion` matching current.
- `decrypt()` round-trips a row encrypted with current key.
- `decrypt()` round-trips a row whose `keyVersion` matches PREVIOUS (uses `VAULT_AES_KEY_PREVIOUS`).
- `decrypt()` throws when row's `keyVersion` matches neither.
- `decrypt()` throws when AES-GCM auth tag fails (no plaintext leaked in error).

### Mutation/action unit tests

- `upsertEncrypted` writes `keyVersion = currentKeyVersion()`.
- `triggerKeyRotation` returns existing pending job's id when one is in flight.
- `rotateAllSubscriptions`:
  - No-ops when all rows are current.
  - Re-wraps rows whose `keyVersion !== current`.
  - Increments `errorCount` + skips when decrypt throws on a row.
  - Idempotent on re-run.
- `exportEncryptedBackup`:
  - Returns base64-encoded JSON.
  - Bundle decrypts cleanly with the same passphrase + salt.
  - Wrong passphrase fails to decrypt (GCM auth tag).
  - Bundle is owner-scoped (no other user's subs included).
  - Rejects passphrase < 12 chars with clear error.
- `importEncryptedBackup`:
  - Round-trips a freshly exported bundle.
  - Wrong passphrase fails clearly.
  - Malformed bundle rejected with shape error.
  - Restored subs land under the caller's userId (cross-user import attempt is impossible — bundle has no user-id field; restore always uses caller's identity).

### Scenario tests (vitest, `*.scenario.test.ts`)

#### `keyRotation.scenario.test.ts`

End-to-end story:

1. Seed user with 3 subs encrypted under "v1".
2. Set `VAULT_AES_KEY_PREVIOUS` = old, `VAULT_AES_KEY` = new, `VAULT_KEY_VERSION` = "v2".
3. Call `triggerKeyRotation` → wait for job to complete.
4. Assert all 3 rows now have `keyVersion === "v2"`.
5. Decrypting each row returns the original plaintext.
6. Subsequent `pullForSwitch` works (proves the round-trip is healthy under the new key).

Variant: assert that introducing a tampered row mid-rotation increments `errorCount` but doesn't abort the others.

#### `backupRoundtrip.scenario.test.ts`

End-to-end story:

1. Seed user A with 2 subs.
2. `exportEncryptedBackup({ passphrase: "correcthorsebatterystaple" })` → save bundle.
3. Soft-remove both subs (simulate disaster).
4. `importEncryptedBackup({ passphrase, bundleBase64 })` → assert restoredCount === 2.
5. Assert subs are back, encrypted under server's current key, decrypt cleanly.
6. `pullForSwitch` on a restored sub works end-to-end.

Variant: same bundle, wrong passphrase → assert restoredCount === 0 + clear error.

Variant: bundle from user A imported by user B fails (bundle decrypts but the restored rows live under user B's userId — semantically a different account). Assert no leakage.

#### `keyRotationDuringWrites.scenario.test.ts`

Race story:

1. Start a rotation job mid-write.
2. Concurrent `upsertFromPlaintext` lands during rotation.
3. Assert: new write has current `keyVersion`; rotation job skips it (filter excludes it); job completes cleanly.

---

## 10. Migration plan

Zero-downtime, single deploy:

1. Ship the schema change (add `keyVersion` optional field). Existing rows have `undefined` keyVersion — `decrypt()` treats as "v1" (== current), uses `VAULT_AES_KEY`.
2. Ship the new actions + mutations. No env-var changes required for the feature to be usable on existing data — first call to `triggerKeyRotation` either:
   - Has `VAULT_KEY_VERSION = "v1"` (default) + matching env vars → rotation no-ops every row (filter excludes them all), `processedRows = 0`, fast completion.
   - Has `VAULT_KEY_VERSION = "v2"` + `VAULT_AES_KEY_PREVIOUS` set → rotation re-wraps every row.

The first case (`v1` → `v1`) is a useful smoke test: the operator can verify the wiring before committing to a real rotation.

---

## 11. Error contract (CLI / dashboard)

| Code                          | When                                                        | UX                                                          |
| ----------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| `ROTATION_IN_FLIGHT`          | `triggerKeyRotation` while a job is `pending`/`running`     | "A rotation job is already running. Job <id> at 67%."       |
| `MISSING_PREVIOUS_KEY`        | `rotateAllSubscriptions` decrypt throws (env var missing)   | Logged per row; surfaces as `errorCount` on the job.        |
| `BACKUP_BAD_PASSPHRASE`       | `importEncryptedBackup` GCM auth tag fails on first account | "Bad passphrase — decryption failed." (No partial restore.) |
| `BACKUP_MALFORMED`            | Bundle JSON parse / shape validation fails                  | "Backup file is malformed or corrupted."                    |
| `BACKUP_PASSPHRASE_TOO_SHORT` | < 12 chars at export time                                   | "Passphrase must be at least 12 characters."                |

---

## 12. Open questions (none blocking)

- **Should rotation run as a single action or chunk via scheduled re-invocation?** Default: single action with paginated reads. Convex action time budget is 10 min — at ~50 rows/sec re-encryption rate that's 30k rows. Far above any realistic single-user vault size (Stefan has 5–10). If we ever blow this budget, switch to scheduled re-invocation.
- **Should backup export include `keyRotationJobs` history?** No — operational metadata, not credential data. Keeping the bundle small + scoped to credentials.
- **Should backup bundle be portable across Convex deployments (e.g. import into a fresh deployment)?** Yes — that's the disaster recovery use case. Importer requires only an authenticated user; a fresh deployment with a new Clerk tenant will simply restore into whatever userId the new tenant assigns.
