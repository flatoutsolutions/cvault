/**
 * `cvault rotate-key` — generate a fresh AES-256 master key, print the
 * env-var update commands, and (after operator confirms) trigger the
 * server-side rotation.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §7.
 *
 * Two-step flow because the operator must update the Convex env vars
 * (which the CLI cannot do for them) before the server can begin
 * rotating. We print the commands, wait for a "yes" confirmation on
 * stdin, then call `triggerKeyRotation`. The server's job-id is
 * returned so the user can correlate with dashboard progress.
 */
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'

import { api } from '@cvault/convex/api'
import type { Id } from '@cvault/convex/dataModel'
import { defineCommand } from 'citty'

import { type VaultClient, makeVaultClient } from '../convex/vaultClient'

interface RotateJobView {
  status: string
  processedRows: number
  totalRows: number
  errorCount: number
  toVersion: string
}

interface RunRotateKeyOpts {
  makeClient?: () => Promise<VaultClient>
  log?: (msg: string) => void
  /** Override the polling interval. Tests pass 0 to skip waits. */
  pollIntervalMs?: number
  /** When true, skip the interactive "type yes" gate. Tests pass true. */
  autoConfirm?: boolean
}

async function readConfirmation(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  try {
    const answer = await rl.question(prompt)
    return answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

export async function runRotateKey(opts: RunRotateKeyOpts = {}): Promise<void> {
  const log = opts.log ?? ((m: string): void => console.log(m))
  const newKey = randomBytes(32).toString('base64')
  log('Generated new AES-256 master key:')
  log(`  NEW_KEY=${newKey}`)
  log('')
  log('Run these commands in your shell to install the new key:')
  log('  npx convex env set VAULT_AES_KEY_PREVIOUS "$(npx convex env get VAULT_AES_KEY)"')
  log(`  npx convex env set VAULT_AES_KEY "${newKey}"`)
  log('  npx convex env set VAULT_KEY_VERSION "v2"   # bump per rotation')
  log('')

  if (!opts.autoConfirm) {
    const confirmed = await readConfirmation('After running those commands, type `yes` to start the rotation: ')
    if (!confirmed) {
      log('Aborted. No rotation triggered.')
      return
    }
  }

  log('Triggering rotation against the server...')

  const client = await (opts.makeClient ?? makeVaultClient)()
  const result = await client.action(api.keyRotationJobs.actions.triggerKeyRotation, client.withMachineLabel({}))
  const triggerResult = result as { jobId: Id<'keyRotationJobs'>; totalRows: number; alreadyRunning: boolean }

  log(`Job ${triggerResult.jobId} (totalRows=${triggerResult.totalRows.toString()})`)
  if (triggerResult.alreadyRunning) {
    log('Note: another rotation job for this user is already in flight; reusing its id.')
  }

  const interval = opts.pollIntervalMs ?? 1000
  let last: RotateJobView = {
    status: 'pending',
    processedRows: 0,
    totalRows: triggerResult.totalRows,
    errorCount: 0,
    toVersion: '',
  }
  while (last.status !== 'completed' && last.status !== 'failed') {
    if (interval > 0) await new Promise((r) => setTimeout(r, interval))
    const job = await client.query(api.keyRotationJobs.queries.getJob, {
      jobId: triggerResult.jobId,
    })
    if (!job) break
    last = {
      status: job.status,
      processedRows: job.processedRows,
      totalRows: job.totalRows,
      errorCount: job.errorCount,
      toVersion: job.toVersion,
    }
    log(`  ${last.processedRows.toString()}/${last.totalRows.toString()} (${last.errorCount.toString()} errors)`)
    // Tests pass pollIntervalMs=0 — break after one cycle so the loop
    // doesn't spin forever on a mocked client that returns the same row.
    if (interval === 0) break
  }
  log(
    `Rotation complete: status=${last.status} processed=${last.processedRows.toString()} ` +
      `errors=${last.errorCount.toString()}`
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
