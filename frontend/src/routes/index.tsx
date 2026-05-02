/**
 * Root route — redirects signed-in users to /dashboard, shows the Clerk
 * sign-in CTA otherwise.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8 (Route table:
 *   "/ → Redirect to /dashboard if authed, else Clerk sign-in").
 *
 * SPA-mode caveat (research brief §2): we cannot use `auth()` from
 * `@clerk/tanstack-react-start/server` for the redirect. We watch
 * `useUser().isSignedIn` client-side and call `navigate({to: '/dashboard'})`
 * once Clerk has loaded.
 */
import { Show, SignInButton, useUser } from '@clerk/tanstack-react-start'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'

import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const navigate = useNavigate()
  const { isLoaded, isSignedIn } = useUser()

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      void navigate({ to: '/dashboard', replace: true })
    }
  }, [isLoaded, isSignedIn, navigate])

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">cvault</h1>
        <p className="text-muted-foreground mt-2 text-base">
          Centralized Claude Code credential vault
        </p>
      </div>

      <Show when="signed-out">
        <SignInButton mode="modal">
          <Button size="lg">Sign in</Button>
        </SignInButton>
      </Show>

      <Show when="signed-in">
        <p className="text-muted-foreground text-sm">Redirecting to dashboard…</p>
      </Show>
    </div>
  )
}
