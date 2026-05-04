/**
 * Import-backup modal: file picker + passphrase + restore.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 *
 * File picker reads a `.cvb` bundle, base64-encodes its contents in
 * chunks (large bundles would overflow `String.fromCharCode(...arr)`),
 * and ships them with the supplied passphrase to
 * `backup.actions.importEncryptedBackup`.
 */
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

import { api } from '../../../../convex/_generated/api'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked btoa: large Uint8Arrays would blow the recursion / arg-list
  // limit if passed straight into `String.fromCharCode(...bytes)`.
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)))
  }
  return btoa(binary)
}

export function ImportBackupDialog({ open, onOpenChange }: Props) {
  const importBackup = useAction(api.backup.actions.importEncryptedBackup)
  const [file, setFile] = useState<File | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setError(null)
    setResult(null)
    if (!file) {
      setError('Pick a .cvb backup file first.')
      return
    }
    setBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const bundleBase64 = bytesToBase64(bytes)
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
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Restoring...' : 'Restore'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
