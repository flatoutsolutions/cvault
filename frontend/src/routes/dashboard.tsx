/**
 * Dashboard layout — wraps every /dashboard/* route with shared chrome
 * (top nav + tooltip provider) and a client-side auth guard.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * SPA-mode auth guard: per docs/research/clerk-convex-tanstack-integration.md
 * §2, `auth()` from `@clerk/tanstack-react-start/server` is unavailable in
 * SPA mode (which Blueprint enables). All gating happens client-side via
 * `<Show when="...">` and `useAuth`.
 */
import { Show, SignInButton, UserButton } from '@clerk/tanstack-react-start'
import { Link, Outlet, createFileRoute } from '@tanstack/react-router'

import ThemeToggle from '@/components/ThemeToggle'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'

export const Route = createFileRoute('/dashboard')({
  component: DashboardLayout,
})

function DashboardLayout() {
  return (
    <TooltipProvider delayDuration={150}>
      <div className="bg-background text-foreground min-h-screen">
        <header className="border-border sticky top-0 z-10 border-b backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
            <Link to="/dashboard" className="text-foreground text-base font-semibold tracking-tight">
              cvault
            </Link>
            <nav className="ml-4 flex items-center gap-1 text-sm">
              <DashboardNavLink to="/dashboard">Subs</DashboardNavLink>
              <DashboardNavLink to="/dashboard/audit">Audit</DashboardNavLink>
              <DashboardNavLink to="/dashboard/machines">Machines</DashboardNavLink>
              <DashboardNavLink to="/dashboard/settings">Settings</DashboardNavLink>
            </nav>
            <div className="ml-auto flex items-center gap-3">
              <ThemeToggle />
              <Show when="signed-in">
                <UserButton />
              </Show>
              <Show when="signed-out">
                <SignInButton mode="modal">
                  <Button size="sm" variant="default">
                    Sign in
                  </Button>
                </SignInButton>
              </Show>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-6">
          <Show when="signed-in">
            <Outlet />
          </Show>
          <Show when="signed-out">
            <SignedOutPlaceholder />
          </Show>
        </main>
      </div>
    </TooltipProvider>
  )
}

function DashboardNavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="text-muted-foreground hover:text-foreground hover:bg-accent rounded-md px-3 py-1.5 transition-colors"
      activeOptions={{ exact: true }}
      activeProps={{ className: 'text-foreground bg-accent' }}
    >
      {children}
    </Link>
  )
}

function SignedOutPlaceholder() {
  return (
    <div className="bg-card border-border flex flex-col items-center gap-4 rounded-lg border p-12 text-center">
      <h1 className="text-2xl font-semibold">Sign in to manage your Claude Code subscriptions</h1>
      <p className="text-muted-foreground max-w-md text-sm">
        cvault keeps your Anthropic OAuth credentials encrypted in Convex and synced across machines. Sign in with the
        same Clerk account you use on your CLI.
      </p>
      <SignInButton mode="modal">
        <Button size="lg">Sign in</Button>
      </SignInButton>
    </div>
  )
}
