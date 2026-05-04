/**
 * 3-step modal driving the key-rotation flow.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 *
 * Steps:
 *   1. Instructions: show the npx convex env set commands the operator
 *      must run to install a fresh AES-256 master key.
 *   2. Confirm: a checkbox-equivalent toggle the operator must check
 *      before the dialog will trigger the server-side rotation.
 *   3. Running / Done: poll the rotation job at 1s intervals and render
 *      a progress bar + processedRows / totalRows + errorCount.
 */
import { useAction, useQuery } from 'convex/react'
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
import { Progress } from '@/components/ui/progress'

import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
}

type Step = 'instructions' | 'confirm' | 'running' | 'done'

const ENV_COMMANDS = `npx convex env set VAULT_AES_KEY_PREVIOUS "$(npx convex env get VAULT_AES_KEY)"
npx convex env set VAULT_AES_KEY "<new-key-from-openssl-rand-base64-32>"
npx convex env set VAULT_KEY_VERSION "v2"`

export function RotateKeyDialog({ open, onOpenChange }: Props) {
  const [step, setStep] = useState<Step>('instructions')
  const [confirmed, setConfirmed] = useState(false)
  const [jobId, setJobId] = useState<Id<'keyRotationJobs'> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const trigger = useAction(api.keyRotationJobs.actions.triggerKeyRotation)
  const job = useQuery(api.keyRotationJobs.queries.getJob, jobId ? { jobId } : 'skip')

  const startRotation = async (): Promise<void> => {
    setError(null)
    setStep('running')
    try {
      const r = await trigger({})
      setJobId(r.jobId)
      if (r.totalRows === 0) {
        setStep('done')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStep('confirm')
    }
  }

  // Auto-advance to "done" when the job completes.
  if (job && (job.status === 'completed' || job.status === 'failed') && step === 'running') {
    setStep('done')
  }

  const close = (): void => {
    setStep('instructions')
    setConfirmed(false)
    setJobId(null)
    setError(null)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate encryption key</DialogTitle>
          <DialogDescription>Re-wrap every stored credential blob with a fresh AES-256 master key.</DialogDescription>
        </DialogHeader>
        {step === 'instructions' && (
          <div className="space-y-3 text-sm">
            <p>
              <strong>1.</strong> Generate a new 32-byte master key:
            </p>
            <pre className="bg-muted rounded p-2 text-xs">openssl rand -base64 32</pre>
            <p>
              <strong>2.</strong> Move the existing key to PREVIOUS, install the new one, bump the version label:
            </p>
            <pre className="bg-muted rounded p-2 text-xs whitespace-pre-wrap">{ENV_COMMANDS}</pre>
            <DialogFooter>
              <Button type="button" onClick={() => setStep('confirm')}>
                Next
              </Button>
            </DialogFooter>
          </div>
        )}
        {step === 'confirm' && (
          <div className="space-y-3 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                aria-label="Confirm env vars updated"
              />
              <span>I have updated VAULT_AES_KEY, VAULT_AES_KEY_PREVIOUS, and VAULT_KEY_VERSION.</span>
            </label>
            {error && <p className="text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="button" disabled={!confirmed} onClick={() => void startRotation()}>
                Start rotation
              </Button>
            </DialogFooter>
          </div>
        )}
        {step === 'running' && (
          <div className="space-y-3 text-sm">
            <p>Rotating subscriptions...</p>
            {job ? (
              <>
                <Progress value={job.totalRows > 0 ? (job.processedRows / job.totalRows) * 100 : 0} />
                <p className="text-muted-foreground">
                  {job.processedRows} / {job.totalRows} rows ({job.errorCount} errors)
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">Starting...</p>
            )}
          </div>
        )}
        {step === 'done' && (
          <div className="space-y-3 text-sm">
            <p>Rotation complete.</p>
            {job && (
              <p className="text-muted-foreground">
                Processed {job.processedRows} of {job.totalRows} rows ({job.errorCount} errors).
              </p>
            )}
            {job && job.errorCount > 0 && (
              <p className="text-destructive text-xs">
                Some rows failed to rotate. Check the dashboard audit log for details. Keep VAULT_AES_KEY_PREVIOUS set
                until they are resolved.
              </p>
            )}
            <DialogFooter>
              <Button type="button" onClick={close}>
                Close
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
