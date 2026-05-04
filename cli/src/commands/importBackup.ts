/**
 * `cvault import <in.cvb>` — restore from an encrypted backup bundle.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §7.
 *
 * Reads the bundle off disk, prompts for passphrase, calls
 * `backup.actions.importEncryptedBackup`, and prints the
 * restored/skipped counts plus any per-account errors the server
 * returned.
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
  const log = opts.log ?? ((m: string): void => console.log(m))
  const passphrase = opts.passphrase ?? (await readPassphrase('Passphrase: '))
  const bundleBase64 = readFileSync(opts.in).toString('base64')

  const client = await (opts.makeClient ?? makeVaultClient)()
  const result = await client.action(
    api.backup.actions.importEncryptedBackup,
    client.withMachineLabel({ passphrase, bundleBase64 })
  )

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
