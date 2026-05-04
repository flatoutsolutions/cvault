/**
 * `cvault export <out.cvb>` — passphrase-encrypted backup of every sub.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §7.
 *
 * Calls `backup.actions.exportEncryptedBackup` and writes the returned
 * base64 bundle to disk. Passphrase is read from stdin (no echo) when
 * not supplied via the test-only `passphrase` option.
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

const MIN_PASSPHRASE_LEN = 12

async function readPassphraseFromStdin(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
  }
}

export async function runExportBackup(opts: RunExportBackupOpts): Promise<void> {
  const log = opts.log ?? ((m: string): void => console.log(m))
  const passphrase = opts.passphrase ?? (await readPassphraseFromStdin('Passphrase (>=12 chars): '))
  if (passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LEN.toString()} characters.`)
  }
  const client = await (opts.makeClient ?? makeVaultClient)()
  const result = await client.action(api.backup.actions.exportEncryptedBackup, client.withMachineLabel({ passphrase }))

  const bytes = Buffer.from(result.contentBase64, 'base64')
  writeFileSync(opts.out, bytes)
  log(`Wrote ${opts.out} (${bytes.byteLength.toString()} bytes, ${result.accountCount.toString()} accounts).`)
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
