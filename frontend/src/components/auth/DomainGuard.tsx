import { useClerk, useUser } from '@clerk/tanstack-react-start'
import { useQuery } from 'convex/react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'

import { api } from '../../../../convex/_generated/api'
import {
  BOOTSTRAP_ALLOWED_DOMAINS,
  BOOTSTRAP_ALLOWED_EMAILS,
  isAllowedEmail,
} from '../../../../convex/utils/domainGate'

export function DomainGuard({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, user } = useUser()
  const { signOut } = useClerk()
  // Both queries are public — the guard runs BEFORE the per-call auth
  // gate so it cannot depend on `authenticatedQuery`.
  const allowedDomainRows = useQuery(api.allowedDomains.queries.list, {})
  const allowedEmailRows = useQuery(api.allowedEmails.queries.list, {})

  if (!isLoaded || allowedDomainRows === undefined || allowedEmailRows === undefined) return null

  const domains =
    allowedDomainRows.length > 0 ? allowedDomainRows.map((r) => r.domain.toLowerCase()) : [...BOOTSTRAP_ALLOWED_DOMAINS]
  const emails =
    allowedEmailRows.length > 0 ? allowedEmailRows.map((r) => r.email.toLowerCase()) : [...BOOTSTRAP_ALLOWED_EMAILS]

  if (!isSignedIn) return <>{children}</>

  const email = user.primaryEmailAddress?.emailAddress ?? null
  if (isAllowedEmail(email, domains, emails)) return <>{children}</>

  return <DomainBlocked onSignOut={() => void signOut()} email={email} domains={domains} emails={emails} />
}

function DomainBlocked({
  onSignOut,
  email,
  domains,
  emails,
}: {
  onSignOut: () => void
  email: string | null
  domains: string[]
  emails: string[]
}) {
  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">cvault is restricted</h1>
        <p className="text-muted-foreground mt-2 max-w-md text-sm">
          Your account{email ? ` (${email})` : ''} is not on the cvault allowlist. Allowed domains:{' '}
          {domains.map((d) => (
            <code key={d} className="bg-muted mx-0.5 rounded px-1 py-0.5 text-xs">
              @{d}
            </code>
          ))}
          {emails.length > 0 ? (
            <>
              {' '}
              · Explicit allowed emails:{' '}
              {emails.map((e) => (
                <code key={e} className="bg-muted mx-0.5 rounded px-1 py-0.5 text-xs">
                  {e}
                </code>
              ))}
            </>
          ) : null}
          .
        </p>
      </div>
      <Button onClick={onSignOut} size="lg" variant="default">
        Sign out
      </Button>
    </div>
  )
}
