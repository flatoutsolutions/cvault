/**
 * /dashboard/machines — list of Clerk sessions that have used the vault.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Track B item 9 (perf): the page component lives in the sibling
 * `machines.lazy.tsx`. This file holds only the static route declaration.
 */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/dashboard/machines')({})
