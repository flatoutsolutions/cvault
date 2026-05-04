import { useClerk, useUser } from '@clerk/tanstack-react-start'
import { useQuery } from 'convex/react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'

import { api } from '../../../../convex/_generated/api'
import { BOOTSTRAP_ALLOWED_DOMAINS, isAllowedEmail } from '../../../../convex/utils/domainGate'

export function DomainGuard({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, user } = useUser()
  const { signOut } = useClerk()
  const allowedRows = useQuery(api.allowedDomains.queries.list, {})

  if (!isLoaded || allowedRows === undefined) return null

  const domains =
    allowedRows.length > 0 ? allowedRows.map((r) => r.domain.toLowerCase()) : [...BOOTSTRAP_ALLOWED_DOMAINS]

  if (!isSignedIn) return <>{children}</>

  const email = user.primaryEmailAddress?.emailAddress ?? null
  if (isAllowedEmail(email, domains)) return <>{children}</>

  return <DomainBlocked onSignOut={() => void signOut()} email={email} domains={domains} />
}

function DomainBlocked({
  onSignOut,
  email,
  domains,
}: {
  onSignOut: () => void
  email: string | null
  domains: string[]
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
          .
        </p>
      </div>
      <Button onClick={onSignOut} size="lg" variant="default">
        Sign out
      </Button>
    </div>
  )
}
