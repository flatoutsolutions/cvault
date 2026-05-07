import { useUser } from '@clerk/tanstack-react-start'
import { zodResolver } from '@hookform/resolvers/zod'
import { createLazyFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { api } from '../../../../../convex/_generated/api'
import type { Id } from '../../../../../convex/_generated/dataModel'

// Strict client-side email validation: trim → email() → lowercase. We
// transform to the canonical lowercased form so the mutation receives
// the same shape regardless of casing the user typed (the server still
// normalizes defensively).
const emailSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email required')
    .max(320, 'Email too long')
    .email('Invalid email format')
    .transform((s) => s.toLowerCase()),
})

type EmailFormValues = z.infer<typeof emailSchema>

export const Route = createLazyFileRoute('/dashboard/settings/emails')({
  component: EmailsPage,
})

export function EmailsPage() {
  const { user } = useUser()
  const callerEmail = (user?.primaryEmailAddress?.emailAddress ?? '').toLowerCase()

  const rows = useQuery(api.allowedEmails.queries.list, {})
  const add = useMutation(api.allowedEmails.mutations.add)
  const remove = useMutation(api.allowedEmails.mutations.remove)

  const [error, setError] = useState<string | null>(null)
  const [pendingRemoveId, setPendingRemoveId] = useState<Id<'allowedEmails'> | null>(null)
  const [pendingRemoveEmail, setPendingRemoveEmail] = useState<string>('')

  const addForm = useForm<EmailFormValues>({
    resolver: zodResolver(emailSchema),
    mode: 'onChange',
    defaultValues: { email: '' },
  })
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = addForm

  const onAdd = handleSubmit(async (values) => {
    setError(null)
    try {
      // `values.email` is already trimmed + lowercased by the Zod schema.
      await add({ email: values.email })
      reset({ email: '' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  })

  async function onConfirmRemove() {
    if (!pendingRemoveId) return
    setError(null)
    try {
      await remove({ id: pendingRemoveId })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingRemoveId(null)
      setPendingRemoveEmail('')
    }
  }

  if (rows === undefined) {
    return <div className="text-muted-foreground p-6 text-sm">Loading…</div>
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Allowed emails</h1>
        <p className="text-muted-foreground text-sm">
          Specific email addresses permitted to sign in to cvault, in addition to the allowed domains. Use this for
          one-off exceptions where opening up a whole domain would be too broad.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="border-border bg-card rounded-lg border p-4 text-sm">
          No explicit emails configured. The allowed-domains list is the only gate. Add an email to grant access without
          opening up its entire domain.
        </div>
      ) : (
        <ul className="border-border bg-card divide-border divide-y rounded-lg border">
          {rows.map((r) => {
            const isOwn = callerEmail.length > 0 && r.email.toLowerCase() === callerEmail
            return (
              <li key={r._id} className="flex items-center justify-between p-3">
                <span className="font-mono text-sm">{r.email}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(isOwn)}
                  onClick={() => {
                    setPendingRemoveId(r._id)
                    setPendingRemoveEmail(r.email)
                  }}
                  aria-label={`Remove ${r.email}`}
                  title={isOwn ? 'You cannot remove your own email' : undefined}
                >
                  Remove
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          void onAdd(e)
        }}
        className="flex flex-col gap-2"
        noValidate
      >
        <Label htmlFor="add-email">Add email</Label>
        <div className="flex items-center gap-2">
          <Input id="add-email" placeholder="someone@example.com" className="max-w-xs" {...register('email')} />
          <Button type="submit" size="sm">
            Add
          </Button>
        </div>
        {errors.email ? (
          <p className="text-destructive text-xs" role="alert">
            {errors.email.message}
          </p>
        ) : null}
      </form>

      {error !== null && (
        <div className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm" role="alert">
          {error}
        </div>
      )}

      <Dialog
        open={pendingRemoveId !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPendingRemoveId(null)
            setPendingRemoveEmail('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove explicit email?</DialogTitle>
            <DialogDescription>
              Removing <code className="bg-muted rounded px-1">{pendingRemoveEmail}</code> revokes access on the user's
              next sign-in (unless their domain is also on the allowed-domains list).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button variant="default" size="sm" onClick={onConfirmRemove}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
