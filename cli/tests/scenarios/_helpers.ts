/**
 * Shared helpers for the CLI scenario suite.
 *
 * Scope (per docs/research/scenario-tests-plan.md §3): scenarios cross
 * command boundaries (e.g. add → list → remove → list). They are NOT unit
 * tests — they exercise the full `runX(opts)` runners against a fake but
 * realistic Convex backend simulated in-memory.
 *
 * Why a Map-backed fake (rather than convex-test) under Bun:
 *   - `convex-test` is wired up only in the convex-* vitest projects,
 *     which run under edge-runtime / node — NOT under Bun. Pulling it in
 *     here would re-compile the entire Convex tree per cli test.
 *   - The CLI's responsibility is "dispatch the right typed function ref
 *     with the right args, then react to its result". A Map-backed fake
 *     lets us assert dispatch (via `getFunctionName`) and inject realistic
 *     return values without spinning up Convex.
 *   - Convex backend's own scenarios (refreshCycle, refreshRace, etc.)
 *     test the server-side behavior these CLI tests stub. The two halves
 *     compose; that's the whole point of the scenario plan §6 split.
 *
 * The fake is intentionally minimal — it has just enough surface to drive
 * the seven CLI scenarios. Anything more would re-implement Convex.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { api } from '@cvault/convex/api'
import type { Id } from '@cvault/convex/dataModel'
import { type FunctionReference, getFunctionName } from 'convex/server'
import type { Mock } from 'vitest'
import { vi } from 'vitest'

// ---------------------------------------------------------------------------
// HOME isolation — every CLI scenario writes into ~/.vault/.
// ---------------------------------------------------------------------------

/**
 * Create a fresh tmpdir and stub `HOME` to point at it. Returns the path so
 * the caller can clean it up. Mirrors the inlined pattern used by
 * `tests/commands/switch.test.ts`.
 */
export function setupTempHome(prefix = 'cvault-scenario-'): string {
  const tempHome = mkdtempSync(join(tmpdir(), prefix))
  vi.stubEnv('HOME', tempHome)
  return tempHome
}

/** Tear down a tmpdir created by `setupTempHome`. Idempotent. */
export function cleanupTempHome(tempHome: string | undefined): void {
  if (tempHome === undefined) return
  rmSync(tempHome, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// In-memory Convex fake.
// ---------------------------------------------------------------------------

export interface FakeSubscription {
  /** Convex Id<'subscriptions'>; opaque string at runtime. */
  _id: Id<'subscriptions'>
  _creationTime: number
  userId: Id<'users'>
  email: string
  slot: number
  label?: string | undefined
  expiresAt: number
  refreshExpiresAt?: number | undefined
  subscriptionType: string
  rateLimitTier: string
  lastRefreshedAt: number
  usage5h?: { pct: number; resetsAt: number; fetchedAt: number } | undefined
  usage7d?: { pct: number; resetsAt: number; fetchedAt: number } | undefined
  removedAt?: number | undefined
  /** Plaintext OAuth blob — fake-only; never persists into Convex. */
  plaintextBlob: string
  /** SHA-256 hex of `plaintextBlob`. Used by `pullForSwitch`. */
  contentHash: string
}

export interface FakeMachineActivity {
  userId: Id<'users'>
  clerkSessionId: string
  action: 'switch' | 'add' | 'pull' | 'remove' | 'refresh'
  subscriptionId?: Id<'subscriptions'>
  at: number
  /**
   * Forwarded from the calling action when the CLI passed a label. The
   * real Convex backend stores this on every row; the fake mirrors that
   * so scenario tests can assert end-to-end label propagation.
   */
  machineLabel?: string
}

export interface FakeRefreshLogEntry {
  userId: Id<'users'>
  subscriptionId: Id<'subscriptions'>
  triggeredBy: 'cron' | 'manual' | 'onUse'
  outcome: 'success' | 'failure' | 'reloginRequired'
  error?: string
  at: number
}

export interface FakeBackendState {
  /** Subs keyed by `_id`. */
  subscriptions: Map<string, FakeSubscription>
  /** Append-only log of activity rows. */
  machineActivity: FakeMachineActivity[]
  /** Append-only log of refresh attempts. */
  refreshLog: FakeRefreshLogEntry[]
  /** Clerk session id stamped on every machineActivity row. */
  clerkSessionId: string
}

/**
 * Identity passthrough for `VaultClient.withMachineLabel` in unit-test
 * fakes that don't care about label propagation. Spread into any inline
 * client literal so the command's `client.withMachineLabel({...})` call
 * doesn't blow up at runtime. Tests covering label propagation should
 * use `createFakeVaultClient({ machineLabel: '...' })` instead.
 */
export function noopWithMachineLabel<T extends Record<string, unknown>>(args: T): T & { machineLabel?: string } {
  return args
}

/**
 * Fake VaultClient — implements the same dispatch surface
 * (`query`/`mutation`/`action` + `withMachineLabel`) as the real
 * `VaultClient`, but routes to in-memory handlers keyed by Convex
 * function name.
 *
 * Tests never construct this directly — they use `installFakeBackend()`
 * which wires it via `vi.mocked(makeVaultClient)`.
 */
export interface FakeVaultClient {
  query: Mock
  mutation: Mock
  action: Mock
  /**
   * Mirrors the real `VaultClient.withMachineLabel` helper. Used by every
   * command call site that writes to `machineActivity` so the dashboard's
   * "Machines" view can render a human-readable label per Clerk session.
   * In the fake, returns the args unchanged unless the test injected a
   * label via `InstallBackendOptions.machineLabel`.
   */
  withMachineLabel: <T extends Record<string, unknown>>(args: T) => T & { machineLabel?: string }
  /** The label this fake client returns from `withMachineLabel`. Read-only. */
  readonly machineLabel: string | undefined
  /** Underlying state — tests can mutate to simulate cron-driven changes. */
  state: FakeBackendState
}

export interface InstallBackendOptions {
  /** Initial subscriptions to seed into the fake. */
  subscriptions?: FakeSubscription[]
  /** Clerk session id to stamp on machineActivity rows. */
  clerkSessionId?: string
  /**
   * Machine label the fake `withMachineLabel` injects. Defaults to
   * `undefined` (i.e. legacy session, args pass through unchanged).
   * Tests covering label propagation set this explicitly.
   */
  machineLabel?: string
  /**
   * One-shot override: when set, `query` / `action` / `mutation` first try
   * this map keyed by full function name (e.g. `subscriptions/actions:pullForSwitch`).
   * Useful for injecting failures (e.g. "this one call rejects with X").
   */
  oneshot?: Partial<Record<string, () => unknown>>
}

/**
 * Compute SHA-256 hex of plaintext — used both by `seedSub` and by the
 * fake `pullForSwitch` to mirror what Convex does in
 * `subscriptions/actions.ts`'s `sha256Hex`.
 */
export async function sha256Hex(input: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Strip the fake-only `plaintextBlob` and `contentHash` fields from a
 * subscription row before returning it through the `listForUser` /
 * `getMetaByEmail` query path. Mirrors what the real Convex queries do
 * with ciphertext + nonce.
 */
function stripPlaintextFields(sub: FakeSubscription): Omit<FakeSubscription, 'plaintextBlob' | 'contentHash'> {
  const { plaintextBlob, contentHash, ...meta } = sub
  void plaintextBlob
  void contentHash
  return meta
}

// ---------------------------------------------------------------------------
// Typed helpers for inspecting mock dispatch.
// ---------------------------------------------------------------------------

/**
 * The pair of arguments any `query` / `mutation` / `action` Mock receives:
 * the typed Convex function reference + the args object.
 *
 * Vitest's `Mock['mock']['calls']` is `unknown[][]` — pulling values out
 * triggers `no-unsafe-assignment`. This helper widens to a typed tuple so
 * tests can read `getCall(spy, 0).ref` / `.args` without `as` casting.
 */
export interface DispatchCall {
  ref: unknown
  args: Record<string, unknown> | undefined
}

/**
 * Read the i-th call to a vi.fn-shaped spy as a typed pair. Throws if no
 * such call exists — that's a test bug, not a runtime concern.
 */
export function getCall(spy: Mock, index: number): DispatchCall {
  const call = spy.mock.calls[index]
  if (!call) {
    throw new Error(`getCall: spy has no call at index ${index.toString()}`)
  }
  return {
    ref: call[0],
    args: call[1] as Record<string, unknown> | undefined,
  }
}

/** Convenience: extract the dotted Convex name from a typed function ref. */
export function refName(ref: unknown): string {
  return getFunctionName(ref as FunctionReference<'query' | 'mutation' | 'action'>)
}

/** Build a realistic `FakeSubscription` row from a partial. */
export async function makeSub(
  overrides: Partial<FakeSubscription> & { email: string; slot: number; plaintextBlob: string }
): Promise<FakeSubscription> {
  const contentHash = overrides.contentHash ?? (await sha256Hex(overrides.plaintextBlob))
  const now = Date.now()
  return {
    _id: (overrides._id ?? `sub_${overrides.slot.toString()}_${overrides.email}`) as Id<'subscriptions'>,
    _creationTime: now,
    userId: (overrides.userId ?? 'user_test_1') as Id<'users'>,
    label: overrides.label,
    expiresAt: overrides.expiresAt ?? now + 60 * 60 * 1000,
    refreshExpiresAt: overrides.refreshExpiresAt,
    subscriptionType: overrides.subscriptionType ?? 'max',
    rateLimitTier: overrides.rateLimitTier ?? 'tier1',
    lastRefreshedAt: overrides.lastRefreshedAt ?? now - 60_000,
    usage5h: overrides.usage5h,
    usage7d: overrides.usage7d,
    removedAt: overrides.removedAt,
    email: overrides.email,
    slot: overrides.slot,
    plaintextBlob: overrides.plaintextBlob,
    contentHash,
  }
}

/** Sample plaintext OAuth blob. The shape is what `claude-swap --export -` emits. */
export const SAMPLE_OAUTH_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA',
    refreshToken: 'sk-ant-ort01-BBBBBBBBBBBBBBBBBBBB',
    expiresAt: 1_900_000_000_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
  },
})

/**
 * Build a `FakeVaultClient` with handlers for every Convex function the CLI
 * touches. Returns the client + a mutable `state` — tests assert on
 * `client.action.mock.calls` for dispatch, and on `state.*` for outcomes.
 */
export function createFakeVaultClient(opts: InstallBackendOptions = {}): FakeVaultClient {
  const state: FakeBackendState = {
    subscriptions: new Map((opts.subscriptions ?? []).map((s) => [s._id as string, s])),
    machineActivity: [],
    refreshLog: [],
    clerkSessionId: opts.clerkSessionId ?? 'sess_test_machine_1',
  }

  function refName(ref: unknown): string {
    return getFunctionName(ref as FunctionReference<'query' | 'mutation' | 'action'>)
  }

  function maybeOneshot<T>(name: string): T | undefined {
    const handler = opts.oneshot?.[name]
    if (!handler) return undefined
    // Single-shot — remove after first invocation.
    delete opts.oneshot?.[name]
    return handler() as T
  }

  const query = vi.fn(async (ref: unknown, args?: Record<string, unknown>): Promise<unknown> => {
    const name = refName(ref)
    const oneshot = maybeOneshot<unknown>(name)
    if (oneshot !== undefined) return await Promise.resolve(oneshot)

    if (name === getFunctionName(api.subscriptions.queries.listForUser)) {
      // `listForUser` is documented to strip ciphertext+nonce. Our fake
      // only stores plaintext (which is also stripped). Mirror the real
      // shape: filter out removedAt and surface the remaining metadata.
      const out: Array<Omit<FakeSubscription, 'plaintextBlob' | 'contentHash'>> = []
      for (const sub of state.subscriptions.values()) {
        if (sub.removedAt !== undefined) continue
        out.push(stripPlaintextFields(sub))
      }
      return out.sort((a, b) => a.slot - b.slot)
    }
    if (name === getFunctionName(api.subscriptions.queries.getMetaByEmail)) {
      const email = (args ?? {}).email
      for (const sub of state.subscriptions.values()) {
        if (sub.email === email && sub.removedAt === undefined) {
          return stripPlaintextFields(sub)
        }
      }
      return null
    }
    throw new Error(`Fake VaultClient: unhandled query "${name}"`)
  })

  const mutation = vi.fn(async (ref: unknown, args?: Record<string, unknown>): Promise<unknown> => {
    const name = refName(ref)
    const oneshot = maybeOneshot<unknown>(name)
    if (oneshot !== undefined) return await Promise.resolve(oneshot)

    if (name === getFunctionName(api.subscriptions.mutations.softRemove)) {
      // Mirror production: lowercase the lookup key. The FAKE's stored
      // emails are also canonicalized in `upsertFromPlaintext` below, so
      // a case-divergent remove still finds the right row.
      const requested = (args ?? {}).email
      const requestedEmail = typeof requested === 'string' ? requested.toLowerCase() : ''
      const callerLabel = (args ?? {}).machineLabel
      let touched: FakeSubscription | undefined
      for (const sub of state.subscriptions.values()) {
        if (sub.email === requestedEmail && sub.removedAt === undefined) {
          sub.removedAt = Date.now()
          touched = sub
        }
      }
      if (!touched) {
        throw new Error(`Fake VaultClient: softRemove found no row for email=${String(requested)}`)
      }
      // Mirror real impl: insert a 'remove' machineActivity row, with
      // the optional machineLabel forwarded by the CLI.
      state.machineActivity.push({
        userId: touched.userId,
        clerkSessionId: state.clerkSessionId,
        action: 'remove',
        subscriptionId: touched._id,
        at: Date.now(),
        ...(typeof callerLabel === 'string' ? { machineLabel: callerLabel } : {}),
      })
      return null
    }
    throw new Error(`Fake VaultClient: unhandled mutation "${name}"`)
  })

  const action = vi.fn(async (ref: unknown, args?: Record<string, unknown>): Promise<unknown> => {
    const name = refName(ref)
    const oneshot = maybeOneshot<unknown>(name)
    if (oneshot !== undefined) return await Promise.resolve(oneshot)

    if (name === getFunctionName(api.subscriptions.actions.pullForSwitch)) {
      const target = (args ?? {}).slotOrEmail as string
      const targetSlot = Number.parseInt(target, 10)
      let match: FakeSubscription | undefined
      for (const sub of state.subscriptions.values()) {
        if (sub.removedAt !== undefined) continue
        if (sub.email === target || sub.slot === targetSlot) {
          match = sub
          break
        }
      }
      if (!match) {
        throw new Error(`Fake VaultClient: no subscription matching ${target}`)
      }
      // Mirror real impl: insert a 'pull' machineActivity row, including
      // the optional machineLabel forwarded by the CLI.
      const callerLabel = (args ?? {}).machineLabel
      state.machineActivity.push({
        userId: match.userId,
        clerkSessionId: state.clerkSessionId,
        action: 'pull',
        subscriptionId: match._id,
        at: Date.now(),
        ...(typeof callerLabel === 'string' ? { machineLabel: callerLabel } : {}),
      })
      return {
        email: match.email,
        slot: match.slot,
        plaintextBlob: match.plaintextBlob,
        contentHash: match.contentHash,
      }
    }
    if (name === getFunctionName(api.subscriptions.actions.upsertFromPlaintext)) {
      const a = args ?? {}
      // Mirror production: canonicalize the email to lowercase before
      // dedupe + storage. See convex/subscriptions/mutations.ts:upsertSub.
      const email = (a.email as string).toLowerCase()
      const plaintextBlob = a.plaintextBlob as string
      const contentHash = await sha256Hex(plaintextBlob)
      const callerLabel = a.machineLabel
      // Find existing slot for this email under same user, else assign next.
      let existing: FakeSubscription | undefined
      let maxSlot = 0
      for (const sub of state.subscriptions.values()) {
        if (sub.slot > maxSlot) maxSlot = sub.slot
        if (sub.email === email) existing = sub
      }
      if (existing) {
        existing.plaintextBlob = plaintextBlob
        existing.contentHash = contentHash
        existing.expiresAt = a.expiresAt as number
        existing.subscriptionType = a.subscriptionType as string
        existing.rateLimitTier = a.rateLimitTier as string
        existing.label = a.label as string | undefined
        existing.removedAt = undefined
        // Mirror real impl: insert an 'add' machineActivity row.
        state.machineActivity.push({
          userId: existing.userId,
          clerkSessionId: state.clerkSessionId,
          action: 'add',
          subscriptionId: existing._id,
          at: Date.now(),
          ...(typeof callerLabel === 'string' ? { machineLabel: callerLabel } : {}),
        })
        return {
          subId: existing._id,
          userId: existing.userId,
          slot: existing.slot,
          created: false,
        }
      }
      const slot = maxSlot + 1
      const id = `sub_${slot.toString()}_${email}` as Id<'subscriptions'>
      const userId = 'user_test_1' as Id<'users'>
      const now = Date.now()
      const row: FakeSubscription = {
        _id: id,
        _creationTime: now,
        userId,
        email,
        slot,
        label: a.label as string | undefined,
        expiresAt: a.expiresAt as number,
        refreshExpiresAt: a.refreshExpiresAt as number | undefined,
        subscriptionType: a.subscriptionType as string,
        rateLimitTier: a.rateLimitTier as string,
        lastRefreshedAt: now,
        plaintextBlob,
        contentHash,
      }
      state.subscriptions.set(id as string, row)
      // Mirror real impl: insert an 'add' machineActivity row.
      state.machineActivity.push({
        userId,
        clerkSessionId: state.clerkSessionId,
        action: 'add',
        subscriptionId: id,
        at: Date.now(),
        ...(typeof callerLabel === 'string' ? { machineLabel: callerLabel } : {}),
      })
      return { subId: id, userId, slot, created: true }
    }
    if (name === getFunctionName(api.subscriptions.actions.requestRefresh)) {
      // CLI scenarios don't drive Anthropic — just acknowledge.
      return null
    }
    throw new Error(`Fake VaultClient: unhandled action "${name}"`)
  })

  const machineLabel = opts.machineLabel
  function withMachineLabel<T extends Record<string, unknown>>(args: T): T & { machineLabel?: string } {
    if (machineLabel === undefined) return args
    return { ...args, machineLabel }
  }

  return { query, mutation, action, state, withMachineLabel, machineLabel }
}
