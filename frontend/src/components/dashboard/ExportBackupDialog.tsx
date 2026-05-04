/**
 * Export-backup modal: passphrase prompt + browser download trigger.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 *
 * Asks for a passphrase + confirmation, calls
 * `backup.actions.exportEncryptedBackup`, then triggers a browser
 * download of the returned base64 bundle via Blob + createObjectURL.
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

const MIN_PASSPHRASE_LEN = 12

/**
 * Decode a base64 string into a fresh ArrayBuffer (NOT a Uint8Array
 * over a SharedArrayBuffer-compatible backing store). Allocating a
 * dedicated ArrayBuffer first lets us pass it to `new Blob([...])`
 * without TypeScript widening to `BufferSource | ArrayBufferLike`,
 * which the Blob constructor rejects under strict typing.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const buf = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return buf
}

export function ExportBackupDialog({ open, onOpenChange }: Props) {
  const exportBackup = useAction(api.backup.actions.exportEncryptedBackup)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setError(null)
    if (passphrase.length < MIN_PASSPHRASE_LEN) {
      setError(`Passphrase must be at least ${MIN_PASSPHRASE_LEN.toString()} characters.`)
      return
    }
    if (passphrase !== confirm) {
      setError('Passphrases do not match.')
      return
    }
    setBusy(true)
    try {
      const result = await exportBackup({ passphrase })
      const buf = base64ToArrayBuffer(result.contentBase64)
      const blob = new Blob([buf], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = result.filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
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
            placeholder="Passphrase (>=12 chars)"
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
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Exporting...' : 'Export backup'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
