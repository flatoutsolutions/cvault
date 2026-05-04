/**
 * Lazy component for /dashboard/settings — split out per Track B item 9.
 *
 * The Rotate Key + Export Backup cards are now wired up to live dialogs
 * (RotateKeyDialog, ExportBackupDialog, ImportBackupDialog). The
 * Refresh-failure notifications card remains a v2 placeholder.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cvault-key-rotation-and-backup-design.md §8.
 */
import { createLazyFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { ExportBackupDialog } from '@/components/dashboard/ExportBackupDialog'
import { ImportBackupDialog } from '@/components/dashboard/ImportBackupDialog'
import { RotateKeyDialog } from '@/components/dashboard/RotateKeyDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const Route = createLazyFileRoute('/dashboard/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  const [rotateOpen, setRotateOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">Account-level controls and operational tooling.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Rotate encryption key</CardTitle>
            <CardDescription>
              Re-wrap every stored credential blob with a fresh AES-256 master key. Use after a suspected key compromise
              or as part of routine credential rotation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" onClick={() => setRotateOpen(true)}>
              Rotate key
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Encrypted backup</CardTitle>
            <CardDescription>
              Download a passphrase-protected bundle of all your subscriptions, secured by a passphrase you choose.
              Restore from any previously exported bundle.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button type="button" onClick={() => setExportOpen(true)}>
              Export backup
            </Button>
            <Button type="button" variant="outline" onClick={() => setImportOpen(true)}>
              Import backup
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

      <RotateKeyDialog open={rotateOpen} onOpenChange={setRotateOpen} />
      <ExportBackupDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ImportBackupDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  )
}
