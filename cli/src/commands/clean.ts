/**
 * `cvault clean` — wipe local Mac state without touching the
 * server-side vault. Idiom mirrors `cargo clean` / `make clean`:
 * artifacts and caches go, configuration stays.
 *
 * Removes:
 *   1. Every `claude-swap`-managed Keychain account (loops
 *      `claude-swap --remove-account <slot>`)
 *   2. Every `~/.vault/last-hash-{email}.txt` file (the per-email cache the
 *      pull-on-use path uses to skip redundant `claude-swap --import`)
 *
 * Preserves:
 *   - `~/.vault/session.json` — user stays signed into the CLI
 *   - Convex vault — `cvault sync --all` will repopulate the Keychain
 *     after this command if the user wants the prior state back
 *
 * Destructive op: prompts y/N unless `--yes` is passed. Each step is
 * idempotent and continues on per-step failure (one bad slot does not
 * block the rest).
 */
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { defineCommand } from 'citty'

import { ClaudeSwapMissingError, purge } from '../claudeSwap'
import { vaultDir } from '../paths'

export interface RunCleanOptions {
  /** Skip the y/N prompt. Required for non-TTY callers. */
  yes?: boolean
  /** Override stdin/stdout for tests. Defaults to `process.std{in,out}`. */
  io?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }
}

interface RemovalSummary {
  /** True when `claude-swap --purge --force` succeeded. */
  keychainPurged: boolean
  hashFilesRemoved: number
  hashFilesFailed: number
}

/**
 * Delete every `last-hash-*.txt` from `~/.vault/`. Returns the {removed,
 * failed} counts so the caller can report them.
 */
function clearHashFiles(): { removed: number; failed: number } {
  const dir = vaultDir()
  if (!existsSync(dir)) return { removed: 0, failed: 0 }
  let removed = 0
  let failed = 0
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith('last-hash-') || !entry.endsWith('.txt')) continue
    try {
      unlinkSync(join(dir, entry))
      removed += 1
    } catch {
      failed += 1
    }
  }
  return { removed, failed }
}

async function confirmClean(io: NonNullable<RunCleanOptions['io']>): Promise<boolean> {
  const rl = createInterface({ input: io.input, output: io.output })
  try {
    const answer = await rl.question(
      'This will remove every claude-swap-managed Keychain account on this ' +
        'machine and delete the local pull-on-use cache. The Convex vault is ' +
        'NOT affected; you stay signed in to cvault. Continue? [y/N] '
    )
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

export async function runClean(opts: RunCleanOptions = {}): Promise<RemovalSummary> {
  const io = opts.io ?? { input: process.stdin, output: process.stdout }

  if (opts.yes !== true) {
    const ok = await confirmClean(io)
    if (!ok) {
      console.log('Aborted.')
      return { keychainPurged: false, hashFilesRemoved: 0, hashFilesFailed: 0 }
    }
  }

  // `claude-swap --purge --force` wipes every managed account in one
  // atomic call. We previously iterated `--remove-account <slot>`, which
  // walked off the end after the very first removal because claude-swap
  // renumbers slots in place (remove slot 1 → old slot 2 becomes slot 1,
  // etc.). The purge call avoids the trap.
  let keychainPurged = false
  try {
    purge()
    keychainPurged = true
  } catch (err) {
    if (err instanceof ClaudeSwapMissingError) {
      console.warn('claude-swap not installed; skipping Keychain wipe.')
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`claude-swap --purge failed: ${msg}`)
    }
  }

  const { removed: hashFilesRemoved, failed: hashFilesFailed } = clearHashFiles()

  const summary: RemovalSummary = {
    keychainPurged,
    hashFilesRemoved,
    hashFilesFailed,
  }
  console.log(
    `${keychainPurged ? 'Purged claude-swap accounts' : 'Skipped Keychain wipe'}, ` +
      `removed ${String(hashFilesRemoved)} hash file(s). Session and Convex vault preserved.`
  )
  return summary
}

export const cleanCommand = defineCommand({
  meta: {
    name: 'clean',
    description:
      'Wipe local claude-swap Keychain accounts and the pull-on-use cache. ' +
      'Server-side vault and CLI session are preserved.',
  },
  args: {
    yes: {
      type: 'boolean',
      description: 'Skip the confirmation prompt.',
      required: false,
      default: false,
    },
  },
  async run({ args }) {
    await runClean({ yes: args.yes })
  },
})
