/**
 * Export-backup modal: passphrase prompt + browser download trigger.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 *
 * Asks for a passphrase + confirmation, calls
 * `backup.actions.exportEncryptedBackup`, then triggers a browser
 * download of the returned base64 bundle via Blob + createObjectURL.
 *
 * Validation is handled by react-hook-form + Zod (`zodResolver`):
 *   - passphrase: min 12 chars
 *   - confirmPassphrase: must equal passphrase
 * Inline error messages render below each input. The submit button is
 * disabled until the form is valid (or while a request is in flight).
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

const exportFormSchema = z
  .object({
    passphrase: z.string().min(MIN_PASSPHRASE_LEN, 'Passphrase must be at least 12 characters'),
    confirmPassphrase: z.string(),
  })
  .refine((d) => d.passphrase === d.confirmPassphrase, {
    message: 'Passphrases do not match.',
    path: ['confirmPassphrase'],
  })

type ExportFormValues = z.infer<typeof exportFormSchema>

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const form = useForm<ExportFormValues>({
    resolver: zodResolver(exportFormSchema),
    mode: 'onChange',
    defaultValues: { passphrase: '', confirmPassphrase: '' },
  })
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isValid },
  } = form

  const onSubmit = handleSubmit(async (values) => {
    setError(null)
    setBusy(true)
    try {
      const result = await exportBackup({ passphrase: values.passphrase })
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
      reset()
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
          <DialogTitle>Export encrypted backup</DialogTitle>
          <DialogDescription>
            Download a passphrase-protected bundle of every subscription. Keep the passphrase safe — without it, the
            bundle cannot be restored.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            void onSubmit(e)
          }}
          noValidate
        >
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <Input
                type="password"
                placeholder="Passphrase (>=12 chars)"
                autoComplete="new-password"
                {...register('passphrase')}
              />
              {errors.passphrase ? <p className="text-destructive text-xs">{errors.passphrase.message}</p> : null}
            </div>
            <div className="space-y-1">
              <Input
                type="password"
                placeholder="Confirm passphrase"
                autoComplete="new-password"
                {...register('confirmPassphrase')}
              />
              {errors.confirmPassphrase ? (
                <p className="text-destructive text-xs">{errors.confirmPassphrase.message}</p>
              ) : null}
            </div>
            {error ? <p className="text-destructive">{error}</p> : null}
          </div>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !isValid}>
              {busy ? 'Exporting...' : 'Export backup'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
