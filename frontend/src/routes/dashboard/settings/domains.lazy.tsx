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
import { extractEmailDomain } from '../../../../../convex/utils/domainGate'

// Strict client-side domain validation. Trim + lowercase before regex
// (Zod runs `.trim()` first; the regex is case-insensitive but we still
// `.transform()` to a lowercased canonical form so the mutation always
// receives the same shape regardless of casing). The regex enforces
// label boundaries (1–63 chars, no leading/trailing hyphen) and at least
// one dot. Length is capped at the DNS-spec 253 chars.
const domainSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(1, 'Domain required')
    .max(253, 'Domain too long')
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i, 'Invalid domain format')
    .transform((s) => s.toLowerCase()),
})

type DomainFormValues = z.infer<typeof domainSchema>

export const Route = createLazyFileRoute('/dashboard/settings/domains')({
  component: DomainsPage,
})

export function DomainsPage() {
  const { user } = useUser()
  const callerEmail = user?.primaryEmailAddress?.emailAddress ?? ''
  const callerDomain = extractEmailDomain(callerEmail)

  const rows = useQuery(api.allowedDomains.queries.list, {})
  const add = useMutation(api.allowedDomains.mutations.add)
  const remove = useMutation(api.allowedDomains.mutations.remove)

  const [error, setError] = useState<string | null>(null)
  const [pendingRemoveId, setPendingRemoveId] = useState<Id<'allowedEmailDomains'> | null>(null)
  const [pendingRemoveDomain, setPendingRemoveDomain] = useState<string>('')

  const addForm = useForm<DomainFormValues>({
    resolver: zodResolver(domainSchema),
    mode: 'onChange',
    defaultValues: { domain: '' },
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
      // `values.domain` is already trimmed + lowercased by the Zod schema.
      await add({ domain: values.domain })
      reset({ domain: '' })
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
      setPendingRemoveDomain('')
    }
  }

  if (rows === undefined) {
    return <div className="text-muted-foreground p-6 text-sm">Loading…</div>
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Allowed email domains</h1>
        <p className="text-muted-foreground text-sm">
          Anyone with a primary email on these domains can sign in to cvault. Empty list falls back to{' '}
          <code className="bg-muted rounded px-1">flatout.solutions</code>.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="border-border bg-card rounded-lg border p-4 text-sm">
          No domains configured. Bootstrap fallback (<code className="bg-muted rounded px-1">flatout.solutions</code>)
          is active. Add a domain to take control of the allowlist.
        </div>
      ) : (
        <ul className="border-border bg-card divide-border divide-y rounded-lg border">
          {rows.map((r) => {
            const isOwn = callerDomain && r.domain.toLowerCase() === callerDomain
            return (
              <li key={r._id} className="flex items-center justify-between p-3">
                <span className="font-mono text-sm">{r.domain}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(isOwn)}
                  onClick={() => {
                    setPendingRemoveId(r._id)
                    setPendingRemoveDomain(r.domain)
                  }}
                  aria-label={`Remove ${r.domain}`}
                  title={isOwn ? 'You cannot remove your own domain' : undefined}
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
        <Label htmlFor="add-domain">Add domain</Label>
        <div className="flex items-center gap-2">
          <Input id="add-domain" placeholder="acme.com" className="max-w-xs" {...register('domain')} />
          <Button type="submit" size="sm">
            Add
          </Button>
        </div>
        {errors.domain ? (
          <p className="text-destructive text-xs" role="alert">
            {errors.domain.message}
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
            setPendingRemoveDomain('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove allowed domain?</DialogTitle>
            <DialogDescription>
              Removing <code className="bg-muted rounded px-1">{pendingRemoveDomain}</code> will revoke access for users
              with this email domain on their next sign-in.
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
