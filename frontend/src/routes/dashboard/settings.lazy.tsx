/**
 * Lazy component for /dashboard/settings — split out per Track B item 9.
 *
 * Per spec §14 (open items deferred to v2):
 *   - Encryption key rotation
 *   - Encrypted backup / disaster recovery export
 *   - Notification on refresh failure
 *   - Per-user mutation rate limiting
 *
 * The placeholders document these for the user; they're intentionally
 * disabled controls so the affordance is honest.
 */
import { createLazyFileRoute } from '@tanstack/react-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const Route = createLazyFileRoute('/dashboard/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">Account-level controls and operational tooling.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Rotate encryption key</CardTitle>
              <Badge variant="outline">v2</Badge>
            </div>
            <CardDescription>
              Re-wrap every stored credential blob with a fresh AES-256 master key. Currently a manual re-add of every
              subscription is required if the key is lost or compromised.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="outline" disabled>
              Rotate key
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Export encrypted backup</CardTitle>
              <Badge variant="outline">v2</Badge>
            </div>
            <CardDescription>
              Download an encrypted bundle of all your subscriptions, secured by a passphrase you choose. Useful for
              disaster recovery if the Convex deployment is lost.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="outline" disabled>
              Export backup
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Refresh-failure notifications</CardTitle>
              <Badge variant="outline">v2</Badge>
            </div>
            <CardDescription>
              Get a Slack DM or email when an OAuth refresh fails permanently (refresh_token revoked / Anthropic returns
              invalid_grant).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="outline" disabled>
              Configure notifications
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
