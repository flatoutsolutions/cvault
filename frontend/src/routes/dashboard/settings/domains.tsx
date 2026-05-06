/**
 * /dashboard/settings/domains — static route declaration.
 *
 * Pairs with `domains.lazy.tsx` (page component). Every dashboard route
 * in this repo follows the `.tsx` (static stub) + `.lazy.tsx` (component)
 * convention. Without this stub, TanStack Router's codegen synthesizes a
 * placeholder `createFileRoute('/dashboard/settings/domains')()` at the
 * top of routeTree.gen.ts — which works in dev but is unreliable for
 * prerendered routes (`tanstackStart` plugin with `crawlLinks: true`)
 * and inconsistent with every other dashboard route.
 */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/dashboard/settings/domains')({})
