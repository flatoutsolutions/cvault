/**
 * /dashboard — the primary sub list page.
 *
 * Spec: docs/superpowers/specs/2026-05-02-cvault-design.md §8.
 *
 * Track B item 9 (perf): the page component lives in the sibling
 * `index.lazy.tsx` so TanStack Router code-splits it into its own
 * chunk. This file holds only the static route declaration that the
 * generated `routeTree.gen.ts` imports.
 */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/dashboard/')({})
