/**
 * AuditRow — single row in the merged audit feed shown on /dashboard/audit.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * The audit feed merges two backends:
 *   - refreshLog rows (Anthropic OAuth refresh attempts, cron + manual + onUse)
 *   - machineActivity rows (CLI operations: switch / add / pull / remove / refresh)
 *
 * Each row gets a normalized `AuditRowData` shape that this component knows
 * how to render. The page is responsible for the merge + sort.
 *
 * Contract under test:
 * - Renders the human label for the action / outcome
 * - Renders a relative timestamp (e.g. "2m ago")
 * - Marks failure / reloginRequired rows with destructive variant
 * - Marks success / regular activity rows as default
 * - Renders an optional sub label (e.g. email) when provided
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AuditRow } from '../AuditRow'

describe('AuditRow', () => {
  it('renders a refresh-success row with default state', () => {
    const { container } = render(
      <AuditRow
        row={{
          kind: 'refresh',
          id: 'log_abc',
          at: Date.now() - 60_000,
          subEmail: 'alice@example.com',
          triggeredBy: 'cron',
          outcome: 'success',
        }}
      />
    )
    expect(screen.getByText(/refresh/i)).toBeTruthy()
    expect(screen.getByText(/alice@example\.com/)).toBeTruthy()
    expect(screen.getByText(/cron/i)).toBeTruthy()
    expect(screen.getByText(/success/i)).toBeTruthy()
    expect(container.querySelector('[data-slot="audit-row"]')?.getAttribute('data-state')).toBe('ok')
  })

  it('renders a refresh-failure row with error state', () => {
    const { container } = render(
      <AuditRow
        row={{
          kind: 'refresh',
          id: 'log_xyz',
          at: Date.now() - 5 * 60_000,
          subEmail: 'bob@example.com',
          triggeredBy: 'manual',
          outcome: 'failure',
          error: 'Anthropic refresh 500: <redacted>',
        }}
      />
    )
    expect(container.querySelector('[data-slot="audit-row"]')?.getAttribute('data-state')).toBe('error')
    expect(screen.getByText(/<redacted>/)).toBeTruthy()
  })

  it('renders a refresh-relogin row with error state', () => {
    const { container } = render(
      <AuditRow
        row={{
          kind: 'refresh',
          id: 'log_x',
          at: Date.now() - 10_000,
          subEmail: 'a@b.com',
          triggeredBy: 'cron',
          outcome: 'reloginRequired',
        }}
      />
    )
    expect(container.querySelector('[data-slot="audit-row"]')?.getAttribute('data-state')).toBe('error')
    expect(screen.getByText(/relogin/i)).toBeTruthy()
  })

  it('renders a machineActivity row', () => {
    render(
      <AuditRow
        row={{
          kind: 'activity',
          id: 'act_1',
          at: Date.now() - 30 * 60_000,
          subEmail: 'alice@example.com',
          action: 'switch',
          ipHash: '12345678',
          clerkSessionId: 'sess_abc',
        }}
      />
    )
    expect(screen.getByText(/switch/i)).toBeTruthy()
    expect(screen.getByText(/12345678/)).toBeTruthy()
  })

  it('renders "—" for activity row without subEmail or ipHash', () => {
    render(
      <AuditRow
        row={{
          kind: 'activity',
          id: 'act_2',
          at: Date.now() - 1000,
          subEmail: undefined,
          action: 'pull',
          ipHash: undefined,
          clerkSessionId: 'sess_def',
        }}
      />
    )
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })
})
