/**
 * Lazy component for /cli/link — split out per Track B item 9.
 *
 * Reference: docs/research/clerk-convex-tanstack-integration.md §4 (the
 * full sign-in token + ticket flow).
 *
 * Flow when a signed-in user lands here:
 *   1. CLI started a localhost listener at `127.0.0.1:<port>` and opened
 *      this page with `?redirect=http://127.0.0.1:<port>/callback&state=<nonce>`.
 *   2. We call `api.cli.actions.startLink({state})` which mints a
 *      single-use Clerk sign-in token tied to the current user.
 *   3. We POST {state, signInToken} to the localhost callback URL —
 *      NEVER 302 the browser there, to avoid leaking the token via
 *      URL bar / referer (research brief §4).
 *   4. CLI redeems the token via Clerk FAPI and stores a session.
 *
 * If the user is not signed in, we tell them to sign in (Clerk modal in
 * the dashboard layout will open via the parent route's <Show>) and
 * re-open the link.
 */
import { useUser } from '@clerk/tanstack-react-start'
import { createLazyFileRoute, useSearch } from '@tanstack/react-router'
import { useAction } from 'convex/react'
import { CheckCircle2, ExternalLink, Loader2, ShieldX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

import { api } from '../../../../convex/_generated/api'

export const Route = createLazyFileRoute('/cli/link')({
  component: CliLinkPage,
})

type Status = 'idle' | 'minting' | 'sending' | 'done' | 'error' | 'need-signin'

/**
 * Exported for tests. The route module above wires this into TanStack
 * Router; tests import this directly so they can render it without
 * the router framework being loaded.
 */
export function CliLinkPage() {
  const { redirect, state } = useSearch({ from: '/cli/link' })
  const { user, isSignedIn, isLoaded } = useUser()
  const startLink = useAction(api.cli.actions.startLink)

  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // useEffect runs twice in dev (Strict Mode); guard against a duplicate
  // mint of the single-use sign-in token.
  const ran = useRef(false)

  useEffect(() => {
    if (!isLoaded) return
    if (!isSignedIn) {
      setStatus('need-signin')
      return
    }
    if (ran.current) return
    ran.current = true

    const exchange = async () => {
      try {
        setStatus('minting')
        const { signInToken } = await startLink({ state })

        setStatus('sending')
        const res = await fetch(redirect, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state, signInToken }),
        })
        if (!res.ok) {
          throw new Error(`Localhost callback returned ${res.status.toString()} ${res.statusText}`)
        }
        setStatus('done')
      } catch (e) {
        console.error('[cvault] CLI link exchange failed', e)
        setErrorMsg(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    }

    void exchange()
  }, [isLoaded, isSignedIn, redirect, state, startLink])

  return (
    <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Link your machine to cvault</CardTitle>
          <CardDescription>
            Confirming the cvault CLI on this machine is allowed to call your Convex deployment as{' '}
            <span className="text-foreground font-medium">{user?.primaryEmailAddress?.emailAddress ?? '…'}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <StatusBlock status={status} errorMsg={errorMsg} redirect={redirect} />
          {status !== 'done' && status !== 'error' && status !== 'need-signin' && (
            <p className="text-muted-foreground text-xs">
              This page POSTs the sign-in token to{' '}
              <code className="bg-muted rounded px-1 py-0.5 font-mono">{redirect}</code>. The token is single-use and
              expires in 10 minutes.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StatusBlock({ status, errorMsg, redirect }: { status: Status; errorMsg: string | null; redirect: string }) {
  if (status === 'idle' || status === 'minting') {
    return (
      <Row icon={<Loader2 className="size-4 animate-spin" aria-hidden />}>
        Asking Convex for a single-use sign-in token…
      </Row>
    )
  }
  if (status === 'sending') {
    return (
      <Row icon={<Loader2 className="size-4 animate-spin" aria-hidden />}>
        Sending the token to the local CLI listener…
      </Row>
    )
  }
  if (status === 'done') {
    return (
      <>
        <Row icon={<CheckCircle2 className="text-emerald-500 size-4" aria-hidden />}>
          Linked. You can close this tab and return to the CLI.
        </Row>
      </>
    )
  }
  if (status === 'need-signin') {
    return (
      <>
        <Row icon={<ShieldX className="text-amber-500 size-4" aria-hidden />}>
          You need to sign in before completing the link.
        </Row>
        <Button asChild>
          <a
            href={`/dashboard?next=${encodeURIComponent(window.location.href)}`}
            className="inline-flex items-center gap-1.5"
          >
            Sign in <ExternalLink className="size-3" aria-hidden />
          </a>
        </Button>
      </>
    )
  }
  // error
  return (
    <>
      <Row icon={<ShieldX className="text-destructive size-4" aria-hidden />}>
        Linking failed. {errorMsg ?? 'Unknown error.'}
      </Row>
      <p className="text-muted-foreground text-xs">
        Check that the cvault CLI is still running and listening on{' '}
        <code className="bg-muted rounded px-1 py-0.5 font-mono">{redirect}</code>, then run{' '}
        <code className="bg-muted rounded px-1 py-0.5 font-mono">cvault login</code> again.
      </p>
    </>
  )
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {icon}
      <span>{children}</span>
    </div>
  )
}
