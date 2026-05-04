/**
 * Import-backup modal: file picker + passphrase + restore.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 *
 * File picker reads a `.cvb` bundle, base64-encodes its contents in
 * chunks (large bundles would overflow `String.fromCharCode(...arr)`),
 * and ships them with the supplied passphrase to
 * `backup.actions.importEncryptedBackup`.
 *
 * Validation is handled by react-hook-form + Zod (`zodResolver`):
 *   - passphrase: min 12 chars
 * The file pick is a runtime check (the input lives outside the form so
 * the browser keeps native file-picker semantics); we still show
 * "Pick a .cvb backup file first." inline if Restore is clicked without
 * a file selected.
 */
import { zodResolver } from '@hookform/resolvers/zod'
import { useAction } from 'convex/react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

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

const importFormSchema = z.object({
  passphrase: z.string().min(MIN_PASSPHRASE_LEN, 'Passphrase must be at least 12 characters'),
})

type ImportFormValues = z.infer<typeof importFormSchema>

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
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const form = useForm<ImportFormValues>({
    resolver: zodResolver(importFormSchema),
    mode: 'onChange',
    defaultValues: { passphrase: '' },
  })
  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = form

  const onSubmit = handleSubmit(async (values) => {
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
      const r = await importBackup({ passphrase: values.passphrase, bundleBase64 })
      setResult(`Restored ${r.restoredCount.toString()} subs (${r.skippedCount.toString()} skipped).`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import encrypted backup</DialogTitle>
          <DialogDescription>Restore subscriptions from a previously exported .cvb bundle.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            void onSubmit(e)
          }}
          noValidate
        >
          <div className="space-y-3 text-sm">
            <Input type="file" accept=".cvb" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <div className="space-y-1">
              <Input type="password" placeholder="Passphrase" autoComplete="off" {...register('passphrase')} />
              {errors.passphrase ? <p className="text-destructive text-xs">{errors.passphrase.message}</p> : null}
            </div>
            {error ? <p className="text-destructive">{error}</p> : null}
            {result ? <p className="text-muted-foreground">{result}</p> : null}
          </div>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !isValid}>
              {busy ? 'Restoring...' : 'Restore'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
